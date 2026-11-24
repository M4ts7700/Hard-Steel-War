-- Base backend for Hard Steel War: player accounts, monthly scores and the original anonymous TOP 5.
-- Rebuilt from the game's client calls for the Frankfurt (eu-central-1) project.
-- Auth settings this needs: email sign-up on, "Confirm email" off, anonymous sign-ins on.
-- Outdated since 202611210001: the game now needs "Confirm email" on and anonymous sign-ins off.
begin;

-- Player accounts (auth email is <username>@accounts.hardsteelwar.invalid).
create table if not exists public.hsw_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  player_id uuid not null unique default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  progress jsonb,
  revision integer not null default 0,
  instagram text not null default '' check (char_length(instagram) <= 100),
  discord text not null default '' check (char_length(discord) <= 100),
  contact_email text not null default '' check (char_length(contact_email) <= 254),
  best_score integer not null default 0,
  last_score_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per finished battle (run id from the client makes retries idempotent).
create table if not exists public.hsw_scores (
  run_id uuid primary key,
  user_id uuid not null references public.hsw_accounts (user_id) on delete cascade,
  score integer not null check (score between 0 and 50000),
  month text not null,
  created_at timestamptz not null default now()
);
create index if not exists hsw_scores_month_idx on public.hsw_scores (month, score desc, created_at);
create index if not exists hsw_scores_user_idx on public.hsw_scores (user_id, score desc, created_at);

-- Original TOP 5: anonymous sign-in, one nick per player, best score kept.
create table if not exists public.iron_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete cascade,
  nick text not null check (char_length(nick) between 3 and 20),
  score integer not null check (score between 0 and 50000),
  updated_at timestamptz not null default now()
);
create unique index if not exists iron_scores_nick_key on public.iron_scores (lower(nick));

-- Snapshot of the old project's public leaderboards (filled once during the move).
create table if not exists public.hsw_imported_leaderboard (
  captured_at timestamptz not null,
  board text not null,
  rank integer not null,
  nick text not null,
  score integer not null
);

alter table public.hsw_accounts enable row level security;
alter table public.hsw_scores enable row level security;
alter table public.iron_scores enable row level security;
alter table public.hsw_imported_leaderboard enable row level security;
revoke all on public.hsw_accounts, public.hsw_scores, public.iron_scores, public.hsw_imported_leaderboard
  from public, anon, authenticated;

-- The signed-in, non-anonymous player's account row (created on first use).
create or replace function public.hsw_current_account()
returns public.hsw_accounts
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  mail text;
  uname text;
  acc public.hsw_accounts;
begin
  if uid is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'registered_account_required';
  end if;
  select * into acc from public.hsw_accounts where user_id = uid;
  if found then return acc; end if;
  select email into mail from auth.users where id = uid;
  uname := lower(split_part(coalesce(mail, ''), '@', 1));
  if mail is null or lower(mail) not like '%@accounts.hardsteelwar.invalid' or uname !~ '^[a-z0-9_]{3,20}$' then
    raise exception 'registered_account_required';
  end if;
  insert into public.hsw_accounts (user_id, username) values (uid, uname)
    on conflict (user_id) do nothing;
  select * into acc from public.hsw_accounts where user_id = uid;
  return acc;
end;
$$;

create or replace function public.hsw_account()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare a public.hsw_accounts := public.hsw_current_account();
begin
  return jsonb_build_object(
    'username', a.username, 'player_id', a.player_id, 'revision', a.revision, 'progress', a.progress,
    'best_score', a.best_score, 'instagram', a.instagram, 'discord', a.discord, 'contact_email', a.contact_email);
end;
$$;

create or replace function public.hsw_save_progress(p_progress jsonb, p_revision integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  a public.hsw_accounts := public.hsw_current_account();
  next_revision integer;
begin
  if p_progress is null or jsonb_typeof(p_progress) <> 'object' or octet_length(p_progress::text) > 20000 then
    raise exception 'invalid_progress' using errcode = '22023';
  end if;
  update public.hsw_accounts
    set progress = p_progress, revision = revision + 1, updated_at = now()
    where user_id = a.user_id and revision = p_revision
    returning revision into next_revision;
  if next_revision is null then raise exception 'cloud_conflict'; end if;
  return next_revision;
end;
$$;

create or replace function public.hsw_save_contacts(p_instagram text, p_discord text, p_email text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  a public.hsw_accounts := public.hsw_current_account();
  ig text := btrim(coalesce(p_instagram, ''));
  dc text := btrim(coalesce(p_discord, ''));
  em text := btrim(coalesce(p_email, ''));
begin
  if char_length(ig) > 100 or char_length(dc) > 100 or char_length(em) > 254
    or (em <> '' and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_contacts';
  end if;
  update public.hsw_accounts set instagram = ig, discord = dc, contact_email = em, updated_at = now()
    where user_id = a.user_id;
  return jsonb_build_object('instagram', ig, 'discord', dc, 'contact_email', em);
end;
$$;

create or replace function public.hsw_submit_score(p_score integer, p_run uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  a public.hsw_accounts := public.hsw_current_account();
  best integer;
begin
  if p_run is null or p_score is null or p_score < 0 or p_score > 50000 then
    raise exception 'invalid_score' using errcode = '22023';
  end if;
  -- A retried upload of the same battle just returns the current record.
  if exists (select 1 from public.hsw_scores where run_id = p_run) then
    return a.best_score;
  end if;
  if a.last_score_at is not null and a.last_score_at > now() - interval '30 seconds' then
    raise exception 'score_cooldown';
  end if;
  insert into public.hsw_scores (run_id, user_id, score, month)
    values (p_run, a.user_id, p_score, to_char(now() at time zone 'Europe/Prague', 'YYYY-MM'));
  update public.hsw_accounts
    set best_score = greatest(best_score, p_score), last_score_at = now(), updated_at = now()
    where user_id = a.user_id
    returning best_score into best;
  return best;
end;
$$;

-- Month (Prague time) or all-time TOP 5. Ties go to the earlier score.
create or replace function public.hsw_top_five(p_monthly boolean default true)
returns table (nick text, score integer, eligible boolean)
language sql stable security definer set search_path = ''
as $$
  with this_month as (select to_char(now() at time zone 'Europe/Prague', 'YYYY-MM') as m),
  played as (
    select distinct on (s.user_id) a.username as nick, s.score, s.created_at as at,
      (a.instagram <> '' or a.discord <> '' or a.contact_email <> '') as eligible
    from public.hsw_scores s join public.hsw_accounts a on a.user_id = s.user_id
    where not p_monthly or s.month = (select m from this_month)
    order by s.user_id, s.score desc, s.created_at asc
  ),
  imported as (
    select i.nick, i.score, i.captured_at as at, true as eligible
    from public.hsw_imported_leaderboard i
    where (p_monthly and i.board = 'monthly'
             and to_char(i.captured_at at time zone 'Europe/Prague', 'YYYY-MM') = (select m from this_month))
       or (not p_monthly and i.board = 'accounts')
  ),
  merged as (
    select distinct on (lower(x.nick)) x.nick, x.score, x.at, x.eligible
    from (select * from played union all select * from imported) x
    where not starts_with(lower(x.nick), 'zz_probe_')
    order by lower(x.nick), x.score desc, x.at asc
  )
  select merged.nick, merged.score, merged.eligible from merged
  order by merged.score desc, merged.at asc
  limit 5
$$;

create or replace function public.iron_submit_score(p_nick text, p_score integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  clean text := btrim(coalesce(p_nick, ''));
  previous public.iron_scores;
  best integer;
begin
  if uid is null then raise exception 'registered_account_required'; end if;
  if char_length(clean) < 3 or char_length(clean) > 20 or clean ~ '[<>[:cntrl:]]'
    or p_score is null or p_score < 0 or p_score > 50000 then
    raise exception 'invalid_score' using errcode = '22023';
  end if;
  select * into previous from public.iron_scores where user_id = uid;
  if found and previous.updated_at > now() - interval '30 seconds' then
    raise exception 'score_cooldown';
  end if;
  insert into public.iron_scores (user_id, nick, score) values (uid, clean, p_score)
    on conflict (user_id) do update
      set nick = excluded.nick, score = greatest(public.iron_scores.score, excluded.score), updated_at = now()
    returning score into best;
  return best;
end;
$$;

create or replace function public.iron_top_five()
returns table (nick text, score integer)
language sql stable security definer set search_path = ''
as $$
  select s.nick, s.score
  from public.iron_scores s
  where not starts_with(lower(s.nick), 'zz_probe_')
  order by s.score desc, lower(s.nick) asc
  limit 5
$$;

revoke all on function public.hsw_current_account() from public, anon, authenticated;
revoke all on function public.hsw_account(), public.hsw_save_progress(jsonb, integer),
  public.hsw_save_contacts(text, text, text), public.hsw_submit_score(integer, uuid),
  public.hsw_top_five(boolean), public.iron_submit_score(text, integer), public.iron_top_five()
  from public, anon, authenticated;
grant execute on function public.hsw_account(), public.hsw_save_progress(jsonb, integer),
  public.hsw_save_contacts(text, text, text), public.hsw_submit_score(integer, uuid),
  public.iron_submit_score(text, integer) to authenticated;
grant execute on function public.hsw_top_five(boolean), public.iron_top_five() to anon, authenticated;

-- Keep the original TOP 5 nicks reserved with their scores.
insert into public.iron_scores (nick, score)
  select i.nick, i.score from public.hsw_imported_leaderboard i
  where i.board = 'legacy'
on conflict do nothing;

notify pgrst, 'reload schema';
commit;
