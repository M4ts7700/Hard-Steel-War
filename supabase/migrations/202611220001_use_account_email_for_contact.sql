begin;

create function public.hsw_registration_contact(address text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when char_length(btrim(address)) <= 254
      and btrim(address) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
      and btrim(address) !~* '\.invalid$'
    then btrim(address)
    else ''
  end
$$;
revoke all on function public.hsw_registration_contact(text) from public, anon, authenticated;

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
      where user_id = new.id and contact_email is distinct from email;
    return new;
  end if;

  if coalesce(new.is_anonymous, false) or uname = '' then return new; end if;
  if uname !~ '^[a-z0-9_]{3,20}$' then raise exception 'invalid_username'; end if;
  insert into public.hsw_accounts (user_id, username, contact_email)
    values (new.id, uname, email);
  return new;
end;
$$;

drop trigger hsw_create_account on auth.users;
create trigger hsw_create_account after insert or update of email on auth.users
  for each row execute function public.hsw_create_account();

-- Keep the third argument for deployed clients. Auth owns the contact address.
create or replace function public.hsw_save_contacts(p_instagram text, p_discord text, p_email text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  a public.hsw_accounts := public.hsw_current_account();
  ig text := btrim(coalesce(p_instagram, ''));
  dc text := btrim(coalesce(p_discord, ''));
  email text;
begin
  if char_length(ig) > 100 or char_length(dc) > 100 then
    raise exception 'invalid_contacts';
  end if;
  update public.hsw_accounts set instagram = ig, discord = dc, updated_at = now()
    where user_id = a.user_id
    returning contact_email into email;
  return jsonb_build_object('instagram', ig, 'discord', dc, 'contact_email', email);
end;
$$;

update public.hsw_accounts a
  set contact_email = public.hsw_registration_contact(u.email), updated_at = now()
  from auth.users u
  where u.id = a.user_id
    and a.contact_email is distinct from public.hsw_registration_contact(u.email);

commit;
