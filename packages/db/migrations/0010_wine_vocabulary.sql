-- ============================================================================
-- 0010  Bor-szótárak: szőlőfajta, bortípus, dűlő
--
-- A bornév azonossághordozó elemei — borászat, borfajta, bortípus, évjárat —
-- közül eddig csak a borászat (producers) és az évjárat volt strukturált.
-- A fajta egy szabad `text[]`, a bortípus szabad szöveg volt, így a
-- "Olaszrizling" és a "Welschriesling" nem oldódott fel egymásra, a
-- "kadarka" és az "olaszrizling" eltérése pedig nem tudott kizárni.
--
-- Ez a migráció a hiányzó három szótárat hozza létre, a producers mintájára.
-- A szinonimák az `aliases` táblába kerülnek, hogy egyetlen, auditált
-- aliaskezelés maradjon (spec 8.10).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Az aliases tábla kiterjesztése az új szótártípusokra
-- ---------------------------------------------------------------------------
ALTER TABLE aliases DROP CONSTRAINT IF EXISTS aliases_alias_type_check;
ALTER TABLE aliases ADD CONSTRAINT aliases_alias_type_check
  CHECK (alias_type IN ('brand','producer','expression','unit','packaging','category',
                        'grape','wine_style','vineyard','wine_region'));

ALTER TABLE aliases DROP CONSTRAINT IF EXISTS aliases_target_kind_check;
ALTER TABLE aliases ADD CONSTRAINT aliases_target_kind_check
  CHECK (target_kind IN ('brand','producer','canonical_variant','product_family','category','literal',
                         'grape_variety','wine_style','vineyard','wine_region'));

-- ---------------------------------------------------------------------------
-- Szőlőfajta. A `colour_default` adja a bortípus alapértelmezését, ha a név
-- nem mondja ki (egy Kékfrankos alapból vörös).
-- A `fuzzy_blocked` azokra a fajtákra való, ahol a trigram-hasonlóság
-- veszélyes: "Kadarka" / "Kadarkakék", "Merlot" / "Menoire".
-- ---------------------------------------------------------------------------
CREATE TABLE grape_varieties (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  text NOT NULL,
  name_norm       text GENERATED ALWAYS AS (rv_search_norm(canonical_name)) STORED,
  colour_default  text CHECK (colour_default IS NULL OR colour_default IN ('red','white','rose','orange')),
  country_origin  text,
  -- A cuvée/házasítás nem valódi fajta, hanem a fajta hiányának jelölése.
  is_blend        boolean NOT NULL DEFAULT false,
  -- Alapból TILOS a fuzzy egyezés. A fajtaeltérés hard gate, ezért egy téves
  -- fuzzy találat csendben összevonna két különböző bort; a kimaradó egyezés
  -- viszont csak review-ba kerül. Az aszimmetria a tiltás felé mutat.
  -- Az elfogadott névváltozatok az aliases táblába kerülnek, auditáltan.
  fuzzy_blocked   boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','proposed','merged','retired')),
  merged_into_id  uuid REFERENCES grape_varieties(id) ON DELETE SET NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX grape_varieties_name_uq ON grape_varieties (name_norm) WHERE status <> 'merged';
CREATE INDEX grape_varieties_trgm_idx ON grape_varieties USING gin (name_norm gin_trgm_ops);
CREATE TRIGGER grape_varieties_touch BEFORE UPDATE ON grape_varieties
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Bortípus. Nem azonos a színnel: az aszú és a szamorodni önálló típus,
-- amelyek színt is implikálnak, de identitásban a színnél erősebbek.
-- ---------------------------------------------------------------------------
CREATE TABLE wine_styles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL UNIQUE,
  canonical_name  text NOT NULL,
  name_norm       text GENERATED ALWAYS AS (rv_search_norm(canonical_name)) STORED,
  colour          text CHECK (colour IS NULL OR colour IN ('red','white','rose','orange')),
  -- Édes desszertbor-típusnál a puttonyszám külön identitásmező (spec 3.1)
  puttony_relevant boolean NOT NULL DEFAULT false,
  sparkling       boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL DEFAULT 100,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','proposed','merged','retired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wine_styles_name_uq ON wine_styles (name_norm) WHERE status <> 'merged';
CREATE INDEX wine_styles_trgm_idx ON wine_styles USING gin (name_norm gin_trgm_ops);
CREATE TRIGGER wine_styles_touch BEFORE UPDATE ON wine_styles
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Dűlő / hegy. Gyakran borászathoz kötött (Gere Kopár), de lehet közös is
-- (Szent György-hegy). A producer_id ezért nullázható.
-- ---------------------------------------------------------------------------
CREATE TABLE vineyards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  text NOT NULL,
  name_norm       text GENERATED ALWAYS AS (rv_search_norm(canonical_name)) STORED,
  producer_id     uuid REFERENCES producers(id) ON DELETE SET NULL,
  region          text,
  country_code    text,
  fuzzy_blocked   boolean NOT NULL DEFAULT true,   -- dűlőnévnél a fuzzy alapból tilos
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','proposed','merged','retired')),
  merged_into_id  uuid REFERENCES vineyards(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vineyards_name_uq ON vineyards (name_norm, coalesce(producer_id::text, ''))
  WHERE status <> 'merged';
CREATE INDEX vineyards_trgm_idx ON vineyards USING gin (name_norm gin_trgm_ops);
CREATE INDEX vineyards_producer_idx ON vineyards (producer_id);
CREATE TRIGGER vineyards_touch BEFORE UPDATE ON vineyards
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Borvidék. Nem azonossághordozó önmagában (két borvidék eltérése nem zár ki,
-- mert az egyik bolt kiírja, a másik nem) — de KI KELL emelni a névből,
-- különben a "Sauska Tokaj Furmint" és a "Sauska Furmint" fantázianeve
-- eltérne, és az expression hard gate tévesen elválasztaná őket.
-- ---------------------------------------------------------------------------
CREATE TABLE wine_regions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  text NOT NULL,
  name_norm       text GENERATED ALWAYS AS (rv_search_norm(canonical_name)) STORED,
  country_code    text,
  parent_id       uuid REFERENCES wine_regions(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','proposed','merged','retired')),
  merged_into_id  uuid REFERENCES wine_regions(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wine_regions_name_uq ON wine_regions (name_norm) WHERE status <> 'merged';
CREATE INDEX wine_regions_trgm_idx ON wine_regions USING gin (name_norm gin_trgm_ops);
CREATE TRIGGER wine_regions_touch BEFORE UPDATE ON wine_regions
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Fajtakapcsolatok. A fajta sokértékű (egy cuvée több fajtából áll), ezért
-- kapcsolótábla. A meglévő `grape_varieties text[]` oszlopok megmaradnak
-- megjelenítési gyorsítótárnak, de az AZONOSSÁG a kapcsolótáblán dől el.
--
-- A `grape_signature` a rendezett fajta-halmaz stabil szöveges lenyomata.
-- Azért denormalizált oszlop, mert egyedi indexben és blocking kulcsban is
-- kell — aggregáló generált oszlop nem lehet. Az írásoldalon a
-- rv_grape_signature() függvénnyel kell frissíteni.
-- ---------------------------------------------------------------------------
CREATE TABLE source_listing_grapes (
  source_listing_id uuid NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  grape_variety_id  uuid NOT NULL REFERENCES grape_varieties(id) ON DELETE RESTRICT,
  position          integer NOT NULL DEFAULT 1,
  share_percent     numeric(5,2),
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source_listing_id, grape_variety_id)
);
CREATE INDEX source_listing_grapes_grape_idx ON source_listing_grapes (grape_variety_id);

CREATE TABLE canonical_variant_grapes (
  canonical_variant_id uuid NOT NULL REFERENCES canonical_variants(id) ON DELETE CASCADE,
  grape_variety_id     uuid NOT NULL REFERENCES grape_varieties(id) ON DELETE RESTRICT,
  position             integer NOT NULL DEFAULT 1,
  share_percent        numeric(5,2),
  PRIMARY KEY (canonical_variant_id, grape_variety_id)
);
CREATE INDEX canonical_variant_grapes_grape_idx ON canonical_variant_grapes (grape_variety_id);

CREATE TABLE product_family_grapes (
  product_family_id uuid NOT NULL REFERENCES product_families(id) ON DELETE CASCADE,
  grape_variety_id  uuid NOT NULL REFERENCES grape_varieties(id) ON DELETE RESTRICT,
  position          integer NOT NULL DEFAULT 1,
  PRIMARY KEY (product_family_id, grape_variety_id)
);

-- A rendezett fajtahalmaz lenyomata. Üres halmaz -> NULL, hogy a
-- "nem tudjuk" és a "bizonyítottan fajta nélküli" ne mosódjon össze.
CREATE OR REPLACE FUNCTION rv_grape_signature(uuid[])
RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS
$$
  SELECT NULLIF(string_agg(g.name_norm, '+' ORDER BY g.name_norm), '')
    FROM unnest(coalesce($1, '{}'::uuid[])) AS u(id)
    JOIN grape_varieties g ON g.id = u.id;
$$;

-- ---------------------------------------------------------------------------
-- Új identitásmezők a listingen és a kanonikus változaton
-- ---------------------------------------------------------------------------
ALTER TABLE source_listings
  ADD COLUMN IF NOT EXISTS wine_style_id   uuid REFERENCES wine_styles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vineyard_id     uuid REFERENCES vineyards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wine_region_id  uuid REFERENCES wine_regions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS grape_signature text;
CREATE INDEX IF NOT EXISTS source_listings_style_idx ON source_listings (wine_style_id);
CREATE INDEX IF NOT EXISTS source_listings_vineyard_idx ON source_listings (vineyard_id);
-- Blocking kulcs a klaszterezéshez: a négy azonossághordozó + a kiszerelés
CREATE INDEX IF NOT EXISTS source_listings_canonical_block_idx
  ON source_listings (producer_id, grape_signature, wine_style_id, vintage_value, volume_ml, pack_count);

ALTER TABLE canonical_variants
  ADD COLUMN IF NOT EXISTS wine_style_id   uuid REFERENCES wine_styles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vineyard_id     uuid REFERENCES vineyards(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS wine_region_id  uuid REFERENCES wine_regions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS grape_signature text;
CREATE INDEX IF NOT EXISTS canonical_variants_style_idx ON canonical_variants (wine_style_id);

ALTER TABLE product_families
  ADD COLUMN IF NOT EXISTS wine_style_id uuid REFERENCES wine_styles(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Az egyedi index kiterjesztése.
-- A régi index szerint egy borászat egy évjárata egy kiszerelésben EGYETLEN
-- változat lehetett — így egy Sauska 2019 Kékfrankos és egy Sauska 2019
-- Olaszrizling ütközött volna. A fajta és a típus azonosságot bont, ezért
-- bekerül a kulcsba.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS canonical_variants_identity_uq;
CREATE UNIQUE INDEX canonical_variants_identity_uq ON canonical_variants (
  product_family_id,
  coalesce(vintage_value, -1),
  coalesce(volume_ml, -1),
  pack_count,
  packaging_type,
  coalesce(lower(edition), ''),
  coalesce(age_statement_years, -1),
  coalesce(grape_signature, ''),
  coalesce(wine_style_id::text, ''),
  coalesce(vineyard_id::text, ''),
  coalesce(puttony, -1)
) WHERE status = 'active';
