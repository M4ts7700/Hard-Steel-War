-- Accounts are created with a real email address; the nickname comes from sign-up metadata.
-- The anonymous "original TOP 5" is retired: anonymous sign-ins are off and its RPCs are closed.
begin;

-- Nickname check before sign-up (case-insensitive, same rules as the game).
create or replace function public.hsw_username_available(p_username text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select lower(btrim(coalesce(p_username, ''))) ~ '^[a-z0-9_]{3,20}$'
    and not exists (select 1 from public.hsw_accounts a where a.username = lower(btrim(p_username)))
$$;

-- Every new email user gets an account row with the nickname chosen at sign-up.
create or replace function public.hsw_create_account()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare uname text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
begin
  if coalesce(new.is_anonymous, false) or uname = '' then return new; end if;
  if uname !~ '^[a-z0-9_]{3,20}$' then raise exception 'invalid_username'; end if;
  insert into public.hsw_accounts (user_id, username) values (new.id, uname);
  return new;
end;
$$;
revoke all on function public.hsw_create_account() from public, anon, authenticated;
drop trigger if exists hsw_create_account on auth.users;
create trigger hsw_create_account after insert on auth.users
  for each row execute function public.hsw_create_account();

-- The signed-in player's account row (no longer derived from the email address).
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
  return acc;
end;
$$;
revoke all on function public.hsw_current_account() from public, anon, authenticated;

revoke all on function public.hsw_username_available(text) from public, anon, authenticated;
grant execute on function public.hsw_username_available(text) to anon, authenticated;

-- Retire the anonymous TOP 5 (data stays in iron_scores, nothing can read or write it from the game).
revoke all on function public.iron_submit_score(text, integer), public.iron_top_five()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
