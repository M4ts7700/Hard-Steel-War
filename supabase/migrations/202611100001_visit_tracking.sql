-- Run once in the SQL Editor of the existing Hard Steel War Supabase project.
begin;

create table if not exists public.hsw_visits (
  id uuid primary key,
  created_at timestamptz not null default now(),
  source text not null check (source in ('direct', 'internal', 'search', 'social', 'other')),
  device text not null check (device in ('mobile', 'desktop')),
  language text not null check (language in ('cs', 'other'))
);
create index if not exists hsw_visits_created_at_idx on public.hsw_visits (created_at);
alter table public.hsw_visits enable row level security;
-- No public SELECT, INSERT, UPDATE or DELETE. Only the bounded insert RPC is exposed.
revoke all on public.hsw_visits from public, anon, authenticated;

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
  insert into public.hsw_visits (id, source, device, language)
    values (visit_id, visit_source, visit_device, visit_language)
    on conflict (id) do nothing;
end;
$$;
revoke all on function public.record_hsw_visit(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_hsw_visit(uuid, text, text, text) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
