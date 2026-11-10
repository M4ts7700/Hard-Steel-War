# Dokončení nasazení

## Návštěvnost v Supabase

1. V projektu `jllejxiyeyshgwilfipy` otevři SQL Editor a spusť soubor `supabase/migrations/202611100001_visit_tracking.sql`.
2. Publikuj aktualizovaný web včetně `visit-tracker.js` a `sw.js`.
3. Otevři veřejný web a pak spusť `supabase/visit-report.sql`. Dostaneš návštěvy za posledních 30 dní v českém časovém pásmu, příchody z vyhledávačů a sociálních sítí a mobilní návštěvy.

Jedna návštěva znamená otevření hry v kartě prohlížeče. Opakované načtení do 30 minut ji nezvýší; další otevření po 30 minutách vytvoří novou návštěvu. Nejde o počet unikátních lidí ani zobrazení stránky. Otevřená hra neposílá pravidelné události. Identifikátor je náhodný, pouze v sessionStorage dané karty. Bez dostupného sessionStorage se může načtení započítat znovu.

Záznam obsahuje pouze náhodné ID, čas přijetí, kategorii zdroje, kategorii šířky obrazovky a `cs`/`other` podle jazyka prohlížeče. Neukládáme účet, e-mail, URL odkazující stránky ani IP do tabulky. Supabase má vlastní provozní logy. Do Not Track a Global Privacy Control měření vypínají. Místní náhledy a jiné domény se nepočítají. Při změně hlavní domény uprav povolenou doménu v `visit-tracker.js`.

Veřejný klíč umí jen zavolat ověřený zápis; čtení a změny tabulky jsou veřejnosti zakázané. Opakované odeslání stejného ID nepřidá návštěvu. Jde o orientační statistiku: blokátory mohou měření vynechat a veřejný zápis lze uměle navyšovat. Pro odolnost vůči cílenému spamu by bylo potřeba přidat serverové omezení požadavků. SQL nezasahuje do účtů ani herních tabulek. Dokud migrace není spuštěná, měření se neuloží a hra běží dál.

## Vyhledávání Google

Publikuj také `robots.txt` a `sitemap.xml` do kořene webu. Stránka obsahuje canonical URL, popis hry, metadata pro sdílení a strukturovaná data VideoGame. Text o hře je v HTML dostupný i bez spuštění JavaScriptu.

V Google Search Console pro `https://hsw.neplytegr.cz/` odešli sitemapu `https://hsw.neplytegr.cz/sitemap.xml` a přes kontrolu URL požádej o indexaci hlavní stránky. Pokud web ještě není ověřený, vlastník musí nejdřív ověřit doménu. Zařazení a pořadí výsledků určuje Google; změna kódu nezaručuje okamžité zobrazení. Viz https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl.

## Ověření změn

Spusť `node --test tests/customization-and-visits.test.cjs`. Testy ověřují velké OBJ, migraci vzhledů, více modelů, zachování volných transformací, soukromí a opakované odesílání návštěv. Živé databázové oprávnění a zápis ověř až po spuštění migrace.

3D import nemá herní limit počtu modelů, polygonů, posunu ani rotace; velikost musí být kladná a hodnoty konečné. Uložení nadále používá kapacitu úložiště prohlížeče. Pokud je plné, hra oznámí neúspěšné uložení a nechá dílnu otevřenou.
