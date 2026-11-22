-- Account settings: change nickname, a contact email that can differ from the login email,
-- and the login email in the profile (email and password changes go through Supabase Auth).
begin;

-- true: the contest contact follows the login email. false: the player entered their own.
alter table public.hsw_accounts add column if not exists contact_uses_login boolean not null default true;

-- A confirmed login email change only updates the contact when the player chose to use it.
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
  insert into public.hsw_accounts (user_id, username, contact_email)
    values (new.id, uname, email);
  return new;
end;
$$;
revoke all on function public.hsw_create_account() from public, anon, authenticated;

-- The profile also carries the login email and an unconfirmed new one, if any.
create or replace function public.hsw_account()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  a public.hsw_accounts := public.hsw_current_account();
  u auth.users;
begin
  select * into u from auth.users where id = a.user_id;
  return jsonb_build_object(
    'username', a.username, 'player_id', a.player_id, 'revision', a.revision, 'progress', a.progress,
    'best_score', a.best_score, 'instagram', a.instagram, 'discord', a.discord, 'contact_email', a.contact_email,
    'contact_uses_login', a.contact_uses_login, 'email', u.email, 'new_email', nullif(u.email_change, ''));
end;
$$;

-- New clients send the checkbox. The three-argument version stays for deployed clients.
create or replace function public.hsw_save_contacts(p_instagram text, p_discord text, p_email text, p_use_login boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  a public.hsw_accounts := public.hsw_current_account();
  ig text := btrim(coalesce(p_instagram, ''));
  dc text := btrim(coalesce(p_discord, ''));
  use_login boolean := coalesce(p_use_login, true);
  em text;
begin
  if use_login then
    select public.hsw_registration_contact(u.email) into em from auth.users u where u.id = a.user_id;
    em := coalesce(em, '');
  else
    em := btrim(coalesce(p_email, ''));
  end if;
  if char_length(ig) > 100 or char_length(dc) > 100 or char_length(em) > 254
    or (em <> '' and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'invalid_contacts';
  end if;
  update public.hsw_accounts
    set instagram = ig, discord = dc, contact_email = em, contact_uses_login = use_login, updated_at = now()
    where user_id = a.user_id;
  return jsonb_build_object('instagram', ig, 'discord', dc, 'contact_email', em, 'contact_uses_login', use_login);
end;
$$;

-- Same nickname rules as sign-up (hsw_username_available).
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
  if exists (select 1 from public.hsw_accounts where username = uname) then raise exception 'username_taken'; end if;
  begin
    update public.hsw_accounts set username = uname, updated_at = now() where user_id = a.user_id;
  exception when unique_violation then
    raise exception 'username_taken';
  end;
  return uname;
end;
$$;

revoke all on function public.hsw_save_contacts(text, text, text, boolean), public.hsw_change_username(text)
  from public, anon, authenticated;
grant execute on function public.hsw_save_contacts(text, text, text, boolean), public.hsw_change_username(text)
  to authenticated;

notify pgrst, 'reload schema';
commit;
