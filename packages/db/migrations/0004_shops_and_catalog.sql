-- ============================================================================
-- 0004  Webshopok, crawl policy, kanonikus termékkatalógus, figyelőlista
-- Spec 8.2 - 8.5, 9., 10.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Crawl policy: forrásonként újrahasználható letöltési szabályrendszer
-- ---------------------------------------------------------------------------
CREATE TABLE crawl_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   text NOT NULL UNIQUE,
  name                  text NOT NULL,
  user_agent            text,
  requests_per_second   numeric(6,3) NOT NULL DEFAULT 0.5,
  max_concurrency       integer NOT NULL DEFAULT 2,
  request_timeout_ms    integer NOT NULL DEFAULT 20000,
  max_retries           integer NOT NULL DEFAULT 3,
  backoff_base_ms       integer NOT NULL DEFAULT 1000,
  backoff_max_ms        integer NOT NULL DEFAULT 60000,
  respect_robots        boolean NOT NULL DEFAULT true,
  allow_browser         boolean NOT NULL DEFAULT false,
  daily_request_budget  integer,
  crawl_window          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"fromHour":1,"toHour":6}
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER crawl_policies_touch BEFORE UPDATE ON crawl_policies
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

CREATE TABLE shop_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Webshopok. A RADOVIN itt EGY a többi közül - semmilyen kiemelt szerep
-- nincs az adatmodellben (spec V2.1 kiegészítés).
-- ---------------------------------------------------------------------------
CREATE TABLE shops (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                       text NOT NULL UNIQUE,       -- 'bortarsasag', 'whiskynet', ...
  name                      text NOT NULL,
  base_url                  text NOT NULL,
  canonical_host            text NOT NULL,
  alternate_hosts           text[] NOT NULL DEFAULT '{}',
  shop_group_id             uuid REFERENCES shop_groups(id) ON DELETE SET NULL,
  segment                   text NOT NULL DEFAULT 'mixed'
                              CHECK (segment IN ('wine','spirit','mixed')),
  active                    boolean NOT NULL DEFAULT true,
  policy_disabled           boolean NOT NULL DEFAULT false,   -- spec 29.2 jogi kapcsoló
  policy_disabled_reason    text,
  crawl_policy_id           uuid REFERENCES crawl_policies(id) ON DELETE SET NULL,
  adapter_key               text NOT NULL,
  adapter_version           text NOT NULL DEFAULT '0.0.0',
  adapter_config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovery_strategy        text NOT NULL DEFAULT 'sitemap'
                              CHECK (discovery_strategy IN ('feed','platform_api','sitemap','category_pages','search_only','manual','browser')),
  discovery_interval_hours  integer NOT NULL DEFAULT 168,
  price_refresh_interval_hours integer NOT NULL DEFAULT 168,
  expected_catalog_min      integer,
  expected_catalog_max      integer,
  catalog_drop_tolerance_pct numeric(5,2) NOT NULL DEFAULT 20.00,
  health_status             text NOT NULL DEFAULT 'unknown'
                              CHECK (health_status IN ('unknown','ok','degraded','failing','blocked','disabled')),
  health_checked_at         timestamptz,
  health_detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  robots_last_checked_at    timestamptz,
  robots_txt_cache          text,
  robots_allows_crawl       boolean,
  terms_last_checked_at     timestamptz,
  terms_review_note         text,
  legal_review_status       text NOT NULL DEFAULT 'pending'
                              CHECK (legal_review_status IN ('pending','approved','restricted','blocked')),
  last_discovery_run_id     uuid,
  last_successful_discovery_at timestamptz,
  last_price_refresh_at     timestamptz,
  next_discovery_at         timestamptz,
  next_price_refresh_at     timestamptz,
  logo_hint                 text,
  brand_color               text,
  sort_order                integer NOT NULL DEFAULT 100,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shops_host_uq ON shops (lower(canonical_host));
CREATE INDEX shops_active_idx ON shops (active, policy_disabled);
CREATE INDEX shops_next_discovery_idx ON shops (next_discovery_at)
  WHERE active AND NOT policy_disabled;
CREATE TRIGGER shops_touch BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- Késleltetett FK-k a 0003-ból
ALTER TABLE category_aliases
  ADD CONSTRAINT category_aliases_shop_fk FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE;
ALTER TABLE aliases
  ADD CONSTRAINT aliases_shop_fk FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Termékcsalád (spec 8.2)
-- ---------------------------------------------------------------------------
CREATE TABLE product_families (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id     uuid NOT NULL REFERENCES product_categories(id) ON DELETE RESTRICT,
  producer_id     uuid REFERENCES producers(id) ON DELETE SET NULL,
  brand_id        uuid REFERENCES brands(id) ON DELETE SET NULL,
  canonical_name  text NOT NULL,
  name_norm       text GENERATED ALWAYS AS (rv_search_norm(canonical_name)) STORED,
  product_line    text,                       -- expression / tételnév
  line_norm       text GENERATED ALWAYS AS (rv_search_norm(product_line)) STORED,
  origin_country  text,
  region          text,
  appellation     text,
  colour          text,                       -- red / white / rose / orange
  grape_varieties text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed','active','merged','suspended','retired')),
  merged_into_id  uuid REFERENCES product_families(id) ON DELETE SET NULL,
  attributes      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_families_category_idx ON product_families (category_id);
CREATE INDEX product_families_producer_idx ON product_families (producer_id);
CREATE INDEX product_families_brand_idx    ON product_families (brand_id);
CREATE INDEX product_families_name_trgm    ON product_families USING gin (name_norm gin_trgm_ops);
CREATE INDEX product_families_status_idx   ON product_families (status);
CREATE TRIGGER product_families_touch BEFORE UPDATE ON product_families
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Kanonikus termékváltozat: a TÉNYLEGES összehasonlítási egység (spec 8.3)
-- ---------------------------------------------------------------------------
CREATE TABLE canonical_variants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_family_id     uuid NOT NULL REFERENCES product_families(id) ON DELETE RESTRICT,
  canonical_display_name text NOT NULL,
  display_name_norm     text GENERATED ALWAYS AS (rv_search_norm(canonical_display_name)) STORED,

  -- Évjárat / korjelölés (spec 13.5)
  vintage_value         integer CHECK (vintage_value IS NULL OR (vintage_value BETWEEN 1800 AND 2100)),
  vintage_status        text NOT NULL DEFAULT 'unknown'
                          CHECK (vintage_status IN ('vintage','non_vintage','not_applicable','unknown')),
  age_statement_years   integer CHECK (age_statement_years IS NULL OR age_statement_years BETWEEN 0 AND 100),
  distillation_year     integer,
  bottling_year         integer,
  batch_code            text,

  -- Kiszerelés (spec 13.4)
  volume_ml             integer CHECK (volume_ml IS NULL OR volume_ml > 0),
  pack_count            integer NOT NULL DEFAULT 1 CHECK (pack_count > 0),
  total_volume_ml       integer GENERATED ALWAYS AS (volume_ml * pack_count) STORED,
  container_type        text,                 -- bottle / can / bag_in_box / keg
  packaging_type        text NOT NULL DEFAULT 'unknown'
                          CHECK (packaging_type IN ('unknown','standard','gift_box','wooden_case','carton','tube','set','tin')),
  gift_contents         text[],

  -- Identitáshordozó jelzők
  edition               text,
  cask_finish           text,
  dosage_style          text,                 -- brut / extra brut / demi-sec
  sweetness             text,
  puttony               integer CHECK (puttony IS NULL OR puttony BETWEEN 3 AND 6),
  abv_percent           numeric(5,2) CHECK (abv_percent IS NULL OR abv_percent BETWEEN 0 AND 100),

  -- Külső azonosítók
  gtin                  text,
  gtin_normalized       text,
  manufacturer_sku      text,
  external_ids          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Kategóriafüggő identitásprofil és összehasonlítási policy (spec 10.1)
  identity_profile_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  comparison_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Mezőnkénti bizonyíték. Kulcs = mezőnév, érték = Evidence objektum (spec 12.2)
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,

  identity_hash         text,      -- a stabil identitásmezőkből számolt fingerprint
  status                text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed','active','merged','suspended','retired')),
  merged_into_id        uuid REFERENCES canonical_variants(id) ON DELETE SET NULL,
  origin                text NOT NULL DEFAULT 'manual'
                          CHECK (origin IN ('manual','import','shop_catalog','auto_discovery','legacy_import','review_split')),
  origin_listing_id     uuid,      -- FK a 0005-ben
  version               integer NOT NULL DEFAULT 1,
  approved_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at           timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  import_batch_id       uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  -- Egy vintage-érzékeny bor nem lehet aktív ismeretlen évjárattal
  CONSTRAINT canonical_variants_vintage_ck
    CHECK (vintage_status <> 'vintage' OR vintage_value IS NOT NULL OR status <> 'active')
);
CREATE INDEX canonical_variants_family_idx  ON canonical_variants (product_family_id);
CREATE INDEX canonical_variants_status_idx  ON canonical_variants (status);
CREATE INDEX canonical_variants_name_trgm   ON canonical_variants USING gin (display_name_norm gin_trgm_ops);
CREATE INDEX canonical_variants_fts_idx     ON canonical_variants USING gin (rv_tsv(canonical_display_name));
CREATE INDEX canonical_variants_gtin_idx    ON canonical_variants (gtin_normalized) WHERE gtin_normalized IS NOT NULL;
CREATE INDEX canonical_variants_block_idx   ON canonical_variants (product_family_id, vintage_value, volume_ml, pack_count);
CREATE INDEX canonical_variants_identity_idx ON canonical_variants (identity_hash) WHERE identity_hash IS NOT NULL;
CREATE TRIGGER canonical_variants_touch BEFORE UPDATE ON canonical_variants
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- Ugyanabban a családban ne jöjjön létre két azonos aktív változat
CREATE UNIQUE INDEX canonical_variants_identity_uq ON canonical_variants (
  product_family_id,
  coalesce(vintage_value, -1),
  coalesce(volume_ml, -1),
  pack_count,
  packaging_type,
  coalesce(lower(edition), ''),
  coalesce(age_statement_years, -1)
) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Figyelőlista. CSAK munkaszervezés - az összehasonlíthatóság nem függ tőle.
-- ---------------------------------------------------------------------------
CREATE TABLE tracked_products (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_variant_id       uuid NOT NULL REFERENCES canonical_variants(id) ON DELETE CASCADE,
  preferred_source_listing_id uuid,     -- FK a 0005-ben, BÁRMELY webshopból
  tracking_origin            text NOT NULL DEFAULT 'manual'
                               CHECK (tracking_origin IN ('manual','import','shop_catalog','auto_discovery')),
  tracking_label             text,
  priority                   integer NOT NULL DEFAULT 100,
  owner_user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  active                     boolean NOT NULL DEFAULT true,
  suspension_reason          text,
  import_batch_id            uuid,
  approved_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at                timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tracked_products_variant_uq ON tracked_products (canonical_variant_id) WHERE active;
CREATE INDEX tracked_products_priority_idx ON tracked_products (priority, created_at) WHERE active;
CREATE TRIGGER tracked_products_touch BEFORE UPDATE ON tracked_products
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();
