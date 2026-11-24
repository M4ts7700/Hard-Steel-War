-- Run once in the SQL Editor (after 202611240001, which enables pg_cron).
-- Account deletion with 7 days to change your mind:
-- the player deletes the account in the game (hsw_delete_account). It is blocked at once: no sign-in,
-- every device signed out, every account RPC refuses it and it leaves the TOP 5. A nightly job deletes it
-- for good 7 days later; the scores and contacts go with it (on delete cascade).
--
-- Support (info@neplytegr.cz), in the SQL Editor:
--   Restore within the 7 days:  select public.hsw_restore_account('player@example.com');
--   Delete right away:          delete from auth.users where lower(email) = lower('player@example.com');
--   Waiting for deletion:       select u.email, a.username, a.delete_requested_at
--                               from public.hsw_accounts a join auth.users u on u.id = a.user_id
--                               where a.delete_requested_at is not null;
begin;

alter table public.hsw_accounts add column if not exists delete_requested_at timestamptz;

-- Same as 202611210001, plus the deletion check every account RPC goes through.
create or replace function public.hsw_current_account()
returns public.hsw_accounts
language plpgsql security definer set search_path = ''
as $$
declare acc public.hsw_accounts;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'registered_account_required';
  end if;
  select * into acc from public.hsw_accounts where user_id = auth.uid();
  if not found then raise exception 'registered_account_required'; end if;
  if acc.delete_requested_at is not null then raise exception 'account_deleted'; end if;
  return acc;
end;
$$;
revoke all on function public.hsw_current_account() from public, anon, authenticated;

create or replace function public.hsw_delete_account()
returns void
language plpgsql security definer set search_path = ''
as $$
declare a public.hsw_accounts := public.hsw_current_account();
begin
  update public.hsw_accounts set delete_requested_at = now(), updated_at = now() where user_id = a.user_id;
  -- The ban stops sign-in and token refresh; deleting the sessions signs out every device.
  update auth.users set banned_until = now() + interval '100 years' where id = a.user_id;
  delete from auth.sessions where user_id = a.user_id;
end;
$$;
revoke all on function public.hsw_delete_account() from public, anon, authenticated;
grant execute on function public.hsw_delete_account() to authenticated;

-- Support only, never exposed to the game. Returns false when no deletion is waiting for that address.
create or replace function public.hsw_restore_account(p_email text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  update public.hsw_accounts set delete_requested_at = null, updated_at = now()
    where user_id = uid and delete_requested_at is not null;
  if not found then return false; end if;
  update auth.users set banned_until = null where id = uid;
  return true;
end;
$$;
revoke all on function public.hsw_restore_account(text) from public, anon, authenticated;

-- Same as 202610200001, minus accounts waiting for deletion.
create or replace function public.hsw_top_five(p_monthly boolean default true)
returns table (nick text, score integer, eligible boolean)
language sql stable security definer set search_path = ''
as $$
  with this_month as (select to_char(now() at time zone 'Europe/Prague', 'YYYY-MM') as m),
  played as (
    select distinct on (s.user_id) a.username as nick, s.score, s.created_at as at,
      (a.instagram <> '' or a.discord <> '' or a.contact_email <> '') as eligible
    from public.hsw_scores s join public.hsw_accounts a on a.user_id = s.user_id
    where (not p_monthly or s.month = (select m from this_month)) and a.delete_requested_at is null
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

-- Every night, delete for good the accounts whose 7 days are over.
select cron.schedule('hsw-delete-requested-accounts', '27 3 * * *', $$
  delete from auth.users u using public.hsw_accounts a
  where a.user_id = u.id and a.delete_requested_at < now() - interval '7 days'
$$);

notify pgrst, 'reload schema';
commit;
