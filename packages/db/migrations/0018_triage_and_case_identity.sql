-- ============================================================================
-- 0018  Hármas szűrő: automatikus jóváhagyás teljes azonosságnál,
--       és az ellenőrzési sor stabilizálása
--
-- Két külön probléma egy migrációban, mert együtt adnak működő egészet:
--
-- 1. AUTOMATIKA. A meglévő automatikus párosítás bornál soha nem tud tüzelni:
--    csak GTIN-egyezésre engedne, a bor EAN-ja viszont több évjáratot is
--    átfog (ezért mondja ki a bor profilja, hogy gtinResolvesVintage=false).
--    Az új út mást kérdez: nem azt, hogy MENNYIRE erős a bizonyítás, hanem
--    hogy TELJES-e.
--
-- 2. A SOR NEM FOGY. Két hiba miatt az ellenőrzési sor akkor is nőne, ha az
--    ember végig dolgozna rajta — lásd lent a részletes indoklást.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Az automatikus jóváhagyás második útja
--
-- Szándékosan KIKAPCSOLVA indul. A bekapcsolás külön, tudatos lépés, a
-- száraz próba (npm run match:triage) számai után.
-- ---------------------------------------------------------------------------
INSERT INTO feature_flags (key, enabled, description) VALUES
('auto_match_identity_complete', false,
 'Automatikus jóváhagyás TELJES bizonyított azonosság esetén, erős azonosító nélkül is. Bornál ez az egyetlen járható út, mert ugyanaz az EAN több évjáratot átfog.')
ON CONFLICT (key) DO NOTHING;

-- Az árarány-küszöb beemelése a meglévő sorba. Az ár SOHA nem utasít el —
-- e fölött az arány fölött csak az automatikus jóváhagyás marad el, és a pár
-- emberi döntésre megy.
UPDATE settings
   SET value = value || '{"priceRatioMax": 3.0}'::jsonb
 WHERE key = 'matching.thresholds'
   AND NOT (value ? 'priceRatioMax');

-- ---------------------------------------------------------------------------
-- 2a. Az eset azonossága: változat + bolt, nem változat + listing
--
-- A régi index a `source_listing_id`-ra kulcsolt. Ha egy újrafuttatás MÁS
-- listinget hozott elsőnek ugyanabban a boltban, az ON CONFLICT nem tüzelt,
-- és MÁSODIK nyitott eset keletkezett ugyanarra a változat+bolt párra. Az
-- ember kétszer döntött volna ugyanarról, a sor pedig magától nőtt.
--
-- A helyes azonosság: egy változatot egy boltban egyszerre egy nyitott eset
-- képvisel. Melyik listing a legjobb jelölt, az a döntés TARTALMA, nem az
-- azonossága.
-- ---------------------------------------------------------------------------

-- A meglévő duplikátumok lezárása: a legfrissebbet tartjuk meg.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY case_type, canonical_variant_id, shop_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM review_cases
   WHERE status IN ('open', 'in_progress', 'deferred')
     AND canonical_variant_id IS NOT NULL
     AND shop_id IS NOT NULL
)
UPDATE review_cases rc
   SET status = 'dismissed',
       resolution = 'auto_resolved',
       resolution_note = 'Duplikált nyitott eset ugyanarra a változat+bolt párra (0018).',
       resolved_at = now(),
       row_version = rc.row_version + 1
  FROM ranked
 WHERE ranked.id = rc.id AND ranked.rn > 1;

DROP INDEX IF EXISTS review_cases_open_pair_uq;

CREATE UNIQUE INDEX review_cases_open_pair_uq ON review_cases (
  case_type,
  coalesce(canonical_variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(shop_id,              '00000000-0000-0000-0000-000000000000'::uuid),
  -- A bolt nélküli esetek (pl. mapping_drift egy listingre) továbbra is a
  -- listing szerint egyediek.
  coalesce(CASE WHEN shop_id IS NULL THEN source_listing_id END,
           '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE status IN ('open', 'in_progress', 'deferred');

COMMENT ON INDEX review_cases_open_pair_uq IS
  'Egy változatot egy boltban egyszerre egy nyitott eset képvisel. Hogy melyik listing a legjobb jelölt, az a döntés tartalma, nem az azonossága.';

-- ---------------------------------------------------------------------------
-- 2b. A söprés kurzora
--
-- A klaszterezésre váró listingek megtalálása ma teljes táblát olvasna. Ez a
-- részleges index teszi olcsóvá a kötegelt feldolgozást.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS source_listings_unclustered_idx
  ON source_listings (shop_id, id)
  WHERE listing_status = 'active' AND cluster_status = 'unclustered';

-- ---------------------------------------------------------------------------
-- 3. Azonosságmag kategóriánként
--
-- Ez mondja meg, mit kell a gépnek BIZONYÍTOTTAN egyezőnek látnia, mielőtt
-- ember nélkül dönthet. Szűkebb, mint a `contradiction_only`: abban benne van
-- a GTIN és a fantázianév is, amik hiánya viszont teljesen normális — azokra
-- várni annyit tenne, hogy soha nem hagyunk jóvá semmit.
--
-- Bornál a felhasználó domainmodellje: borászat + fajta + szín (ezt a bortípus
-- mondja ki, hiányában a fajta alapértelmezése) + évjárat, kiegészítve a
-- fizikai kiszereléssel — mert egy 0,75 l és egy 1,5 l külön eladható egység.
--
-- A `wine_style` szándékosan NINCS benne: sok bolt nem írja ki, viszont ha
-- mindkét oldalon ismert és eltér, akkor `contradiction_only`-ként úgyis
-- kizár. A szín viszont a fajtából levezethető, ezért bizonyítható.
-- ---------------------------------------------------------------------------

UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":["producer","grape_varieties","colour","vintage","volume_ml","pack_count","packaging_type"]}'::jsonb
 WHERE key = 'wine';

-- Pezsgőnél a dosage (brut / extra dry / demi-sec) eladható különbség.
UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":["producer","colour","vintage","dosage_style","volume_ml","pack_count","packaging_type"]}'::jsonb
 WHERE key IN ('sparkling_wine', 'champagne');

-- Tokaji aszúnál a puttonyszám önálló identitásmező (spec 3.1).
UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":["producer","vintage","puttony","volume_ml","pack_count","packaging_type"]}'::jsonb
 WHERE key = 'tokaji_aszu';

-- Tömény: a márka és az expression hordozza az azonosságot, évjárat helyett
-- a kor. A whiskynél a kormegjelölés eladható különbség (12 vs 18 éves).
UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":["brand","expression","age_statement_years","volume_ml","pack_count","packaging_type"]}'::jsonb
 WHERE key IN ('whisky', 'rum', 'cognac');

UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":["brand","expression","volume_ml","pack_count","packaging_type"]}'::jsonb
 WHERE key IN ('gin', 'vodka', 'tequila', 'liqueur', 'other_spirit');

-- A pálinkánál a termelő és a gyümölcs a lényeg.
UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":["producer","fruit","expression","volume_ml","pack_count","packaging_type"]}'::jsonb
 WHERE key = 'palinka';

-- A besorolatlan termék SOHA nem kaphat automatikus jóváhagyást. Üres mag =
-- nincs mire alapozni, tehát marad az ember.
UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":[]}'::jsonb
 WHERE key = 'uncategorized';
