-- ---------------------------------------------------------------------------
-- 0022 — A kanonikus tételnév pótlása, és a kategória-források tisztítása
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. A kanonikus oldal TÉTELNEVE
--
-- A `promoteListingToVariant` eddig nem töltötte ki a
-- `product_families.product_line` mezőt, az összehasonlítás viszont
-- visszaesett a megjelenítési névre — vagyis a változatot létrehozó bolt
-- teljes NYERS terméknevére.
--
-- A jelölt oldalon ugyanez a mező a parser rövid maradéka:
--
--   kanonikus: "Sauska Cuvée 13 2022 Villányi 14% 0,75l"
--   jelölt:    "13"
--
-- Az `expression` KEMÉNY kizáró jel. A két különböző dolog összehasonlítása
-- tehát nem tartózkodást, hanem NÉMA ELUTASÍTÁST szül valódi párokra.
--
-- Amíg a bolti oldalon üres volt az `expression`, ez rejtve maradt: a
-- hiányzó érték „nem tudjuk"-ot ad. Az újrakinyerés viszont pontosan ezt
-- tölti ki — a hiba tehát éppen a javítástól élesedett volna.
--
-- A pótlás forrása az a listing, AMIBŐL a változat készült. Nem találunk ki
-- semmit: azt írjuk be, amit a parser abból a névből kiolvasott.
-- ===========================================================================

UPDATE product_families pf
   SET product_line = src.expression
  FROM (
    SELECT DISTINCT ON (cv.product_family_id)
           cv.product_family_id AS family_id,
           sl.expression
      FROM canonical_variants cv
      JOIN source_listings sl ON sl.id = cv.origin_listing_id
     WHERE cv.status <> 'merged'
       AND sl.expression IS NOT NULL
       AND btrim(sl.expression) <> ''
     ORDER BY cv.product_family_id, cv.created_at
  ) src
 WHERE src.family_id = pf.id
   AND pf.product_line IS NULL;

-- ===========================================================================
-- 2. Kategória-aliaszok, amik KÜLÖNBÖZŐ termékeket vontak össze
--
-- A kategória időközben kemény kizáró jellé vált. Ettől a rossz besorolás
-- súlyosabb lett: eddig csak pontot vont, most némán kizár — vagy éppen
-- HAMIS EGYEZÉST ad két különböző termékre.
--
-- Három alias köt össze olyat, ami nem ugyanaz:
--
--   brandy   -> cognac    A cognac védett eredetmegjelölés; minden cognac
--                         brandy, de a legtöbb brandy nem cognac.
--   armagnac -> cognac    Két külön régió, külön eljárás.
--   mezcal   -> tequila   A tequila kizárólag kék agávéból készül.
--
-- Nem töröljük őket: az `other_spirit` a helyük. Ez azért fontos, mert a
-- besorolatlan termék profilja szerint semmi nem hagyható jóvá gépileg — a
-- törlés tehát emberi sorba tolná ezeket. Az `other_spirit` viszont az
-- összehasonlítóban MINDEN tömény kategóriával „rokon", vagyis tartózkodik:
-- nem zár ki, de nem is állít hamis egyezést.
-- ===========================================================================

UPDATE category_aliases ca
   SET category_id = (SELECT id FROM product_categories WHERE key = 'other_spirit')
 WHERE ca.alias_norm IN (rv_search_norm('brandy'), rv_search_norm('armagnac'))
   AND ca.category_id = (SELECT id FROM product_categories WHERE key = 'cognac');

UPDATE category_aliases ca
   SET category_id = (SELECT id FROM product_categories WHERE key = 'other_spirit')
 WHERE ca.alias_norm = rv_search_norm('mezcal')
   AND ca.category_id = (SELECT id FROM product_categories WHERE key = 'tequila');

-- ===========================================================================
-- 3. Hiányzó pezsgő-aliaszok a KATEGÓRIA-feloldáshoz
--
-- A 0021 a BORTÍPUS szótárát bővítette (`wine_styles`). A morzsaútból
-- dolgozó kategória-feloldás viszont másik táblát néz (`category_aliases`),
-- és ott a pezsgő mindössze hat alakot ismer.
--
-- A kettő eddig külön élt, és emiatt ugyanarról a névről mást mondhattak.
-- Itt a kategória-oldalt hozzuk szintre.
-- ===========================================================================

INSERT INTO category_aliases (category_id, alias)
SELECT c.id, a.alias FROM product_categories c
JOIN (VALUES
  ('sparkling_wine','pezsgők és habzóborok'),
  ('sparkling_wine','pezsgő és habzóbor'),
  ('sparkling_wine','gyöngyöző'),
  ('sparkling_wine','gyöngyözőbor'),
  ('sparkling_wine','frizzante'),
  ('sparkling_wine','spumante'),
  ('sparkling_wine','sekt'),
  ('sparkling_wine','crémant'),
  ('sparkling_wine','cremant'),
  ('sparkling_wine','franciacorta'),
  ('sparkling_wine','pezsgő, habzóbor'),
  ('tokaji_aszu','tokaji aszú eszencia'),
  ('tokaji_aszu','aszú eszencia'),
  ('tokaji_aszu','szamorodni')
) AS a(cat, alias) ON a.cat = c.key
ON CONFLICT DO NOTHING;
