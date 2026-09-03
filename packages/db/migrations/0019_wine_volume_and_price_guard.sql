-- ============================================================================
-- 0019  A kiszerelés kivétele a bor azonosságmagjából, és szigorúbb ár-őr
--
-- A száraz próba számai alapján (319 bor-listing):
--   borászat 100% · évjárat 89% · szín 85% · fajta 75% · KISZERELÉS 46%
--
-- A kiszerelés a szűk keresztmetszet, és nem kinyerési hiba: a boltok több
-- mint felénél sem a névben, sem a spec-táblában nem szerepel. Kivárni tehát
-- nem lehet — az `extractIdentity` már ma is végigolvassa mindkettőt.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A kiszerelés kikerül a bor azonosságmagjából
--
-- Ez NEM azt jelenti, hogy feltételezzük az egyezést. A `volume_ml` marad
-- `contradiction_only`, `hardOnMismatch: true` — ha MINDKÉT bolt kiírja és
-- eltér, továbbra is kizár. Csak azt mondjuk ki, hogy a mező HIÁNYA önmagában
-- ne igényeljen emberi döntést.
--
-- Ez pontosan a felhasználó domainszabálya: „az adat lehet hiányos, de ahol
-- mindkét oldalon ismert és eltér, ott kizár". És ugyanaz a bánásmód, amit a
-- bortípus már most kap.
--
-- A `pack_count` és a `packaging_type` MARAD a magban: mindkettő NOT NULL
-- alapértelmezéssel, tehát soha nem blokkol, viszont egy bizonyított 6-os
-- karton így nem párosodhat egy palackkal.
--
-- Vállalt kockázat: egy magnum, amit a bolt nem jelöl, összecsúszhat egy
-- 0,75-össel. Ezt részben a lentebb szigorított ár-őr fogja el — egy magnum
-- jellemzően 2x fölött van.
-- ---------------------------------------------------------------------------

UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":["producer","grape_varieties","colour","vintage","pack_count","packaging_type"]}'::jsonb
 WHERE key = 'wine';

UPDATE product_categories SET identity_profile = identity_profile ||
  '{"identity_core":["producer","colour","vintage","dosage_style","pack_count","packaging_type"]}'::jsonb
 WHERE key IN ('sparkling_wine', 'champagne');

-- A tokaji aszú SZÁNDÉKOSAN kimarad: ott a 0,5 l a szabvány, de a 0,25 és a
-- 0,375 is él, és prémium tételről van szó, ahol a téves párosítás drága. Ott
-- a kiszerelés marad bizonyítandó.
--
-- A tömények szintén érintetlenek: ott a kiszerelés érzékenyebb (0,2 / 0,5 /
-- 0,7 / 1,0 mind bevett), és nincs olyan uralkodó alapértelmezés, mint bornál
-- a 0,75.

-- ---------------------------------------------------------------------------
-- 2. Az ár-őr szigorítása 3x-ről 2x-re
--
-- Az ár továbbra sem utasít el semmit — e fölött az arány fölött csak az
-- automatikus jóváhagyás marad el, és a pár emberi döntésre megy.
--
-- A 2x bőven a valós bolti szórás (15-25%) fölött van, viszont elkapja a
-- kiszerelés-eltérésből fakadó tévedéseket: egy magnum vagy egy karton ára
-- jellemzően kétszeres fölött van. Így a két változtatás egymást fedi.
-- ---------------------------------------------------------------------------

UPDATE settings
   SET value = jsonb_set(value, '{priceRatioMax}', '2.0'::jsonb)
 WHERE key = 'matching.thresholds' AND active;

-- ---------------------------------------------------------------------------
-- 3. A kiszerelés szerepe is `required`-ből `contradiction_only`-ba kerül
--
-- Enélkül a rendszer két ellentmondó dolgot állítana ugyanarról a mezőről: az
-- azonosságmagból kivettük, a szerepe szerint viszont továbbra is KÖTELEZŐ.
-- A gyakorlati következmény látható lenne — minden borpár a
-- „Kötelező kiszerelés nem bizonyított" indokot viselné az ellenőrzésben,
-- még az is, amit a gép amúgy jóváhagy.
--
-- A `contradiction_only` pontosan azt mondja, amit akarunk: ha mindkét oldalon
-- ismert és eltér, kizár; ha hiányzik, nem kér embert.
--
-- Az aszú és a tömények itt is érintetlenek.
-- ---------------------------------------------------------------------------

UPDATE product_categories SET identity_profile = identity_profile ||
  '{"required":["producer","vintage","pack_count","packaging_type"],
    "contradiction_only":["grape_varieties","wine_style","vineyard","expression","colour","region","sweetness","abv_percent","edition","gtin","appellation","volume_ml"]}'::jsonb
 WHERE key = 'wine';

UPDATE product_categories SET identity_profile = identity_profile ||
  '{"required":["producer","dosage_style","vintage_status","pack_count","packaging_type"],
    "contradiction_only":["grape_varieties","wine_style","vineyard","expression","vintage","colour","region","abv_percent","edition","gtin","volume_ml"]}'::jsonb
 WHERE key = 'sparkling_wine';

UPDATE product_categories SET identity_profile = identity_profile ||
  '{"required":["producer","dosage_style","vintage_status","pack_count","packaging_type"],
    "contradiction_only":["grape_varieties","wine_style","vineyard","expression","vintage","region","abv_percent","edition","gtin","colour","volume_ml"]}'::jsonb
 WHERE key = 'champagne';
