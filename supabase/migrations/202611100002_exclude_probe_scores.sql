-- Exclude probe profiles before selecting the five best real players.
-- Keep the score records intact; this presentation filter is reversible.
create or replace function public.iron_top_five()
returns table(nick text, score integer)
language sql
stable
security definer
set search_path = ''
as $function$
  select s.nick, s.score
  from public.iron_scores s
  where not starts_with(lower(s.nick), 'zz_probe_')
  order by s.score desc, lower(s.nick) asc
  limit 5
$function$;
