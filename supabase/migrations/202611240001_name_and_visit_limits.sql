-- Run once in the SQL Editor. Three limits that need only the database:
-- 1. Names from the imported leaderboards stay reserved, so a new account cannot show an old record as its own.
-- 2. Sign-ups that stay unconfirmed for a day are deleted, which frees their nickname.
-- 3. The visit counter accepts at most 60 visits a minute, so a script cannot fill the database.
-- Part 2 needs the pg_cron extension. If "create extension" fails, enable pg_cron in Database → Extensions and run again.
begin;

-- 1. hsw_top_five merges these two boards with real accounts by name.
-- Names already taken before this migration (often the old player who signed up again):
--   select i.board, i.nick from public.hsw_imported_leaderboard i
--   where i.board in ('monthly', 'accounts')
--     and exists (select 1 from public.hsw_accounts a where a.username = lower(i.nick));
create or replace function public.hsw_name_reserved(p_username text)
returns boolean
language sql stable set search_path = ''
as $$
  select exists (select 1 from public.hsw_imported_leaderboard i
    where i.board in ('monthly', 'accounts') and lower(i.nick) = p_username)
$$;
revoke all on function public.hsw_name_reserved(text) from public, anon, authenticated;

create or replace function public.hsw_username_available(p_username text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select lower(btrim(coalesce(p_username, ''))) ~ '^[a-z0-9_]{3,20}$'
    and not exists (select 1 from public.hsw_accounts a where a.username = lower(btrim(p_username)))
    and not public.hsw_name_reserved(lower(btrim(p_username)))
$$;

create or replace function public.hsw_change_username(p_username text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  a public.hsw_accounts := public.hsw_current_account();
  uname text := lower(btrim(coalesce(p_username, '')));
begin
  if uname !~ '^[a-z0-9_]{3,20}$' then raise exception 'invalid_username'; end if;
  if uname = a.username then return uname; end if;
  if exists (select 1 from public.hsw_accounts where username = uname) or public.hsw_name_reserved(uname) then
    raise exception 'username_taken';
  end if;
  begin
    update public.hsw_accounts set username = uname, updated_at = now() where user_id = a.user_id;
  exception when unique_violation then
    raise exception 'username_taken';
  end;
  return uname;
end;
$$;

-- Same as 202611220002, plus the reserved-name check for sign-ups that skip hsw_username_available.
create or replace function public.hsw_create_account()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  uname text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  email text := public.hsw_registration_contact(new.email);
begin
  if tg_op = 'UPDATE' then
    update public.hsw_accounts set contact_email = email, updated_at = now()
      where user_id = new.id and contact_uses_login and contact_email is distinct from email;
    return new;
  end if;

  if coalesce(new.is_anonymous, false) or uname = '' then return new; end if;
  if uname !~ '^[a-z0-9_]{3,20}$' then raise exception 'invalid_username'; end if;
  if public.hsw_name_reserved(uname) then raise exception 'username_taken'; end if;
  insert into public.hsw_accounts (user_id, username, contact_email)
    values (new.id, uname, email);
  return new;
end;
$$;

-- 2. The account row (and its nickname) is created at sign-up, before the email is confirmed.
-- Every night, delete sign-ups older than a day that were never confirmed; the account row goes with them.
-- Never touches anonymous users (the retired TOP 5) or an account that ever saved progress or a score.
create extension if not exists pg_cron;
select cron.schedule('hsw-delete-unconfirmed-signups', '17 3 * * *', $$
  delete from auth.users u
  where u.email_confirmed_at is null and u.email is not null and not coalesce(u.is_anonymous, false)
    and u.created_at < now() - interval '1 day'
    and not exists (select 1 from public.hsw_accounts a
      where a.user_id = u.id and (a.revision > 0 or a.best_score > 0))
$$);

-- 3. Same as 202611100001, plus a global cap (it uses hsw_visits_created_at_idx).
-- shortcut: during a real spike above 60 visits a minute the extra visits are not counted; raise the cap if traffic gets there.
create or replace function public.record_hsw_visit(
  visit_id uuid, visit_source text, visit_device text, visit_language text
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if visit_id is null or visit_source is null or visit_device is null or visit_language is null
    or visit_source not in ('direct', 'internal', 'search', 'social', 'other')
    or visit_device not in ('mobile', 'desktop') or visit_language not in ('cs', 'other') then
    raise exception 'Invalid visit' using errcode = '22023';
  end if;
  if (select count(*) from public.hsw_visits where created_at > now() - interval '1 minute') >= 60 then
    return;
  end if;
  insert into public.hsw_visits (id, source, device, language)
    values (visit_id, visit_source, visit_device, visit_language)
    on conflict (id) do nothing;
end;
$$;

notify pgrst, 'reload schema';
commit;
