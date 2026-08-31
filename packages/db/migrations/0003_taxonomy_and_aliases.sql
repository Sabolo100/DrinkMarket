-- ============================================================================
-- 0003  Taxonómia, márkák, termelők, aliasok, identitáshordozó kifejezések
-- Spec 8.10, 13.2, 13.3
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Kategóriák. Fa szerkezet, kategóriánként eltérő identitásprofillal.
-- ---------------------------------------------------------------------------
CREATE TABLE product_categories (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                 text NOT NULL UNIQUE,          -- 'wine', 'whisky', 'palinka', ...
  parent_id           uuid REFERENCES product_categories(id) ON DELETE RESTRICT,
  name_hu             text NOT NULL,
  name_en             text,
  kind                text NOT NULL CHECK (kind IN ('wine','spirit','other')),
  -- Az identitásprofil kategóriaszintű alapértelmezése (spec 10.1)
  identity_profile    jsonb NOT NULL DEFAULT '{}'::jsonb,
  comparison_policy   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Kategóriafüggő, VERZIÓZOTT zajszólista. Általános stopword TILOS (spec 13.2).
  noise_terms         text[] NOT NULL DEFAULT '{}',
  noise_terms_version integer NOT NULL DEFAULT 1,
  sort_order          integer NOT NULL DEFAULT 100,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_categories_parent_idx ON product_categories (parent_id);
CREATE TRIGGER product_categories_touch BEFORE UPDATE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

CREATE TABLE category_aliases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   uuid NOT NULL REFERENCES product_categories(id) ON DELETE CASCADE,
  alias         text NOT NULL,
  alias_norm    text GENERATED ALWAYS AS (rv_search_norm(alias)) STORED,
  shop_id       uuid,      -- FK a 0004 migrációban, NULL = globális
  source        text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual','import','learned','ai_suggested')),
  approved      boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX category_aliases_uq
  ON category_aliases (alias_norm, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX category_aliases_cat_idx ON category_aliases (category_id);

-- ---------------------------------------------------------------------------
-- Termelő (borászat / desztilláló) és márka külön entitás.
-- ---------------------------------------------------------------------------
CREATE TABLE producers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  text NOT NULL,
  name_norm       text GENERATED ALWAYS AS (rv_search_norm(canonical_name)) STORED,
  country_code    text,
  region          text,
  website         text,
  kind            text NOT NULL DEFAULT 'unknown'
                    CHECK (kind IN ('winery','distillery','producer','importer','unknown')),
  -- Személynév-alapú pincészeteknél a fuzzy egyezés tiltott (spec 13.3)
  fuzzy_blocked   boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','proposed','merged','retired')),
  merged_into_id  uuid REFERENCES producers(id) ON DELETE SET NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX producers_name_uq ON producers (name_norm) WHERE status <> 'merged';
CREATE INDEX producers_trgm_idx ON producers USING gin (name_norm gin_trgm_ops);
CREATE TRIGGER producers_touch BEFORE UPDATE ON producers
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

CREATE TABLE brands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  text NOT NULL,
  name_norm       text GENERATED ALWAYS AS (rv_search_norm(canonical_name)) STORED,
  producer_id     uuid REFERENCES producers(id) ON DELETE SET NULL,
  category_id     uuid REFERENCES product_categories(id) ON DELETE SET NULL,
  country_code    text,
  fuzzy_blocked   boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','proposed','merged','retired')),
  merged_into_id  uuid REFERENCES brands(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brands_name_uq ON brands (name_norm) WHERE status <> 'merged';
CREATE INDEX brands_trgm_idx ON brands USING gin (name_norm gin_trgm_ops);
CREATE INDEX brands_producer_idx ON brands (producer_id);
CREATE TRIGGER brands_touch BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Egységes alias-tábla. Minden aliashoz bizonyíték és jóváhagyó tartozik.
-- Egy párosítás jóváhagyása NEM hoz létre automatikusan globális aliast
-- (spec 8.10) - a promóció külön adminművelet, ami approved = true-ra állít.
-- ---------------------------------------------------------------------------
CREATE TABLE aliases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_type        text NOT NULL
                      CHECK (alias_type IN ('brand','producer','expression','unit','packaging','category')),
  alias_text        text NOT NULL,
  alias_norm        text GENERATED ALWAYS AS (rv_search_norm(alias_text)) STORED,
  target_kind       text NOT NULL
                      CHECK (target_kind IN ('brand','producer','canonical_variant','product_family','category','literal')),
  target_id         uuid,
  target_literal    text,               -- unit / packaging normalizált értékhez
  shop_id           uuid,               -- NULL = globális, egyébként webshop-specifikus
  scope_category_id uuid REFERENCES product_categories(id) ON DELETE SET NULL,
  source            text NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual','import','review_promotion','ai_suggested','learned')),
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved          boolean NOT NULL DEFAULT false,
  approved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  proposed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  hit_count         integer NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (target_id IS NOT NULL OR target_literal IS NOT NULL)
);
CREATE UNIQUE INDEX aliases_uq ON aliases (
  alias_type, alias_norm,
  coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(target_literal, '')
);
CREATE INDEX aliases_lookup_idx  ON aliases (alias_type, alias_norm) WHERE approved AND active;
CREATE INDEX aliases_target_idx  ON aliases (target_kind, target_id);
CREATE INDEX aliases_pending_idx ON aliases (created_at DESC) WHERE NOT approved;
CREATE TRIGGER aliases_touch BEFORE UPDATE ON aliases
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Identitáshordozó kifejezések: SOHA nem dobhatók el zajszóként (spec 10.4, 13.2)
-- pl. 'double black', 'reserve', 'brut', '5 puttonyos', 'cask strength'
-- ---------------------------------------------------------------------------
CREATE TABLE identity_terms (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term                text NOT NULL,
  term_norm           text GENERATED ALWAYS AS (rv_search_norm(term)) STORED,
  term_class          text NOT NULL
                        CHECK (term_class IN ('expression','edition','age','dosage','sweetness','cask','style','puttony','packaging','strength','colour')),
  category_id         uuid REFERENCES product_categories(id) ON DELETE CASCADE,
  contradiction_class text NOT NULL DEFAULT 'expression',
  weight              numeric(4,3) NOT NULL DEFAULT 1.000,
  notes               text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX identity_terms_uq
  ON identity_terms (term_norm, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX identity_terms_class_idx ON identity_terms (term_class) WHERE active;

-- ---------------------------------------------------------------------------
-- Negatív aliasok: hasonló, de bizonyítottan NEM azonos termékvonalak
-- pl. 'black label' <> 'double black'
-- ---------------------------------------------------------------------------
CREATE TABLE negative_aliases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  left_text     text NOT NULL,
  left_norm     text GENERATED ALWAYS AS (rv_search_norm(left_text)) STORED,
  right_text    text NOT NULL,
  right_norm    text GENERATED ALWAYS AS (rv_search_norm(right_text)) STORED,
  category_id   uuid REFERENCES product_categories(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX negative_aliases_uq
  ON negative_aliases (left_norm, right_norm, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX negative_aliases_left_idx  ON negative_aliases (left_norm);
CREATE INDEX negative_aliases_right_idx ON negative_aliases (right_norm);
