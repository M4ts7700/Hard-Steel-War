-- Private report: run in Supabase SQL Editor. Missing dates are shown as zero.
with days as (
  select generate_series(
    (now() at time zone 'Europe/Prague')::date - 29,
    (now() at time zone 'Europe/Prague')::date,
    interval '1 day'
  )::date as day
)
select d.day as den, count(v.id) as navstevy,
  count(v.id) filter (where v.source = 'search') as vyhledavace,
  count(v.id) filter (where v.source = 'social') as socialni_site,
  count(v.id) filter (where v.device = 'mobile') as mobilni
from days d left join public.hsw_visits v
  on v.created_at >= (d.day::timestamp at time zone 'Europe/Prague')
  and v.created_at < ((d.day + 1)::timestamp at time zone 'Europe/Prague')
group by d.day order by d.day desc;
