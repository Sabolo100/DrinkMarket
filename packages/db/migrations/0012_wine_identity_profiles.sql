-- ============================================================================
-- 0012  A bor kategóriák identitásprofiljának átszabása
--
-- Két dolog változik, mindkettő a bornév valódi szerkezetéből következik.
--
-- 1. Az `expression` KIKERÜL a required közül.
--    Az expression a slot-kitöltéses felbontás után már nem a teljes nevet
--    jelenti, hanem a FANTÁZIANEVET — ami a bolti névből gyakran hiányzik
--    ("Sauska Kékfrankos 2019" simán megjelenhet fantázianév nélkül).
--    Required mezőként egy ismeretlen fantázianév minden párosítást
--    megfojtana: az evidence_coverage sosem érné el a küszöböt.
--    Contradiction_only szerepben viszont pontosan azt teszi, amit kell:
--    ha MINDKÉT oldalon ismert és eltér, kizár; ha hiányzik, tartózkodik.
--
-- 2. A `grape_varieties`, a `wine_style` és a `vineyard` azonossághordozóvá
--    lép elő (contradiction_only), és a comparators.ts-ben valódi hard
--    gate-et kap. Eddig a fajta eltérése csak a pontszámot rontotta — így
--    egy olaszrizling és egy kadarka elvben összeérhetett.
--
-- Előfeltétel: a 0010/0011 szótárak és a slot-kitöltéses parser. A hard gate
-- csak KANONIKUS nevekre feloldott fajtákon biztonságos; nyers szövegen az
-- "Olaszrizling" és a "Welschriesling" hamis kizárást adna.
-- ============================================================================

-- ── Csendes bor ─────────────────────────────────────────────────────────────
UPDATE product_categories SET identity_profile = '{
  "required":["producer","vintage","volume_ml","pack_count","packaging_type"],
  "contradiction_only":["grape_varieties","wine_style","vineyard","expression",
                        "colour","region","sweetness","abv_percent","edition",
                        "gtin","appellation"],
  "supporting":["country_code","organic"],
  "not_applicable":["age_statement_years","dosage_style","cask_finish","puttony"],
  "vintageSensitive":true,
  "gtinResolvesVintage":false
}'::jsonb
WHERE key = 'wine';

-- ── Pezsgő: az évjárat itt nem kötelező (a nem évjáratos a norma), de a
--    dosage_style igen. A fajta és a dűlő itt is kizáró.
UPDATE product_categories SET identity_profile = '{
  "required":["producer","dosage_style","vintage_status","volume_ml","pack_count","packaging_type"],
  "contradiction_only":["grape_varieties","wine_style","vineyard","expression",
                        "vintage","colour","region","abv_percent","edition","gtin"],
  "supporting":["country_code"],
  "not_applicable":["age_statement_years","cask_finish","puttony"],
  "vintageSensitive":true,
  "gtinResolvesVintage":false
}'::jsonb
WHERE key = 'sparkling_wine';

UPDATE product_categories SET identity_profile = '{
  "required":["producer","dosage_style","vintage_status","volume_ml","pack_count","packaging_type"],
  "contradiction_only":["grape_varieties","wine_style","vineyard","expression",
                        "vintage","region","abv_percent","edition","gtin","colour"],
  "supporting":["country_code"],
  "not_applicable":["age_statement_years","cask_finish","puttony"],
  "vintageSensitive":true,
  "gtinResolvesVintage":false
}'::jsonb
WHERE key = 'champagne';

-- ── Tokaji aszú: a puttonyszám MARAD kötelező (spec 3.1 — az 5 és a 6
--    puttonyos külön termék), és a bortípus itt különösen fontos
--    (aszú / szamorodni / fordítás nem ugyanaz).
UPDATE product_categories SET identity_profile = '{
  "required":["producer","vintage","puttony","volume_ml","pack_count","packaging_type"],
  "contradiction_only":["wine_style","grape_varieties","vineyard","expression",
                        "region","sweetness","abv_percent","edition","gtin"],
  "supporting":["country_code"],
  "not_applicable":["age_statement_years","dosage_style","cask_finish"],
  "vintageSensitive":true,
  "gtinResolvesVintage":false
}'::jsonb
WHERE key = 'tokaji_aszu';
