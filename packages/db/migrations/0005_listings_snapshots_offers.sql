-- ============================================================================
-- 0005  Crawl futások, webshop-listingek, snapshotok, ajánlat-megfigyelések
-- Spec 8.6 - 8.8, 11., 12., 18., 19.4
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Crawl / discovery / refresh futás. A quality gate ehhez kötődik (spec 31).
-- ---------------------------------------------------------------------------
CREATE TABLE crawl_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  run_type            text NOT NULL
                        CHECK (run_type IN ('discovery','price_refresh','health_check','targeted_search','single_url','adapter_test')),
  trigger             text NOT NULL DEFAULT 'scheduler'
                        CHECK (trigger IN ('scheduler','manual','review','api','retry','system')),
  triggered_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','succeeded','partial','failed','quarantined','cancelled')),
  source_status       text CHECK (source_status IN ('ok','partial','blocked','rate_limited','timeout','unavailable','parse_error','catalog_regression','policy_disabled')),

  -- Verziórögzítés (spec 19.4/2)
  adapter_key         text NOT NULL,
  adapter_version     text NOT NULL,
  extractor_version   text,
  matcher_version     text,
  taxonomy_version    text,
  config_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,

  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         integer,

  -- Diagnosztika (spec 11.4)
  requests_attempted  integer NOT NULL DEFAULT 0,
  requests_succeeded  integer NOT NULL DEFAULT 0,
  requests_failed     integer NOT NULL DEFAULT 0,
  requests_retried    integer NOT NULL DEFAULT 0,
  rate_limit_hits     integer NOT NULL DEFAULT 0,
  pages_seen          integer NOT NULL DEFAULT 0,
  urls_discovered     integer NOT NULL DEFAULT 0,
  urls_duplicate      integer NOT NULL DEFAULT 0,
  listings_new        integer NOT NULL DEFAULT 0,
  listings_updated    integer NOT NULL DEFAULT 0,
  listings_unchanged  integer NOT NULL DEFAULT 0,
  listings_missing    integer NOT NULL DEFAULT 0,
  extract_ok          integer NOT NULL DEFAULT 0,
  extract_failed      integer NOT NULL DEFAULT 0,
  http_status_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,
  catalog_size_before integer,
  catalog_size_after  integer,
  catalog_hash        text,
  completeness        text CHECK (completeness IN ('complete','partial','unknown')),
  robots_decision     text,
  browser_used        boolean NOT NULL DEFAULT false,
  browser_time_ms     integer,

  -- Quality gate (spec 31.1)
  quality_gate_passed boolean,
  quality_gate_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at        timestamptz,
  quarantine_reason   text,

  warnings            jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors              jsonb NOT NULL DEFAULT '[]'::jsonb,
  correlation_id      text,
  notes               text
);
CREATE INDEX crawl_runs_shop_idx    ON crawl_runs (shop_id, started_at DESC);
CREATE INDEX crawl_runs_status_idx  ON crawl_runs (status, started_at DESC);
CREATE INDEX crawl_runs_type_idx    ON crawl_runs (run_type, started_at DESC);
-- Egy shopon egyszerre csak egy futó teljes discovery (spec 19.5)
CREATE UNIQUE INDEX crawl_runs_single_discovery_uq
  ON crawl_runs (shop_id) WHERE status = 'running' AND run_type = 'discovery';

-- FIGYELEM: ez a megszoritas kort zar be (shops -> crawl_runs -> shops).
-- Uzemszeru mukodest nem befolyasol, de a `TRUNCATE crawl_runs CASCADE`
-- emiatt a SHOPS tablat is kiuritene. Karbantartaskor eloszor
-- `UPDATE shops SET last_discovery_run_id = NULL`, utana `DELETE FROM crawl_runs`.
ALTER TABLE shops
  ADD CONSTRAINT shops_last_discovery_fk
  FOREIGN KEY (last_discovery_run_id) REFERENCES crawl_runs(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Webshop-listing: a webshopban talált termék/variáns STABIL rekordja.
-- Minden megtalált listing bekerül, függetlenül a párosíthatóságtól (V2.1).
-- ---------------------------------------------------------------------------
CREATE TABLE source_listings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- Platformazonosítók: az elsődleges egyediségi kulcs (spec 8.6)
  platform_product_id   text,
  platform_variant_id   text,
  sku                   text,
  gtin                  text,
  gtin_normalized       text,

  canonical_url         text NOT NULL,
  url_key               text NOT NULL,       -- forrásonként kanonizált URL kulcs
  final_url             text,
  redirect_chain        jsonb NOT NULL DEFAULT '[]'::jsonb,

  raw_name              text NOT NULL,
  normalized_name       text GENERATED ALWAYS AS (rv_search_norm(raw_name)) STORED,
  raw_brand             text,
  raw_category_path     text[],
  image_url             text,

  -- Kinyert, strukturált identitásmezők (a snapshot legfrissebb állapota)
  producer_id           uuid REFERENCES producers(id) ON DELETE SET NULL,
  brand_id              uuid REFERENCES brands(id) ON DELETE SET NULL,
  category_id           uuid REFERENCES product_categories(id) ON DELETE SET NULL,
  expression            text,
  expression_norm       text GENERATED ALWAYS AS (rv_search_norm(expression)) STORED,
  vintage_value         integer,
  vintage_status        text NOT NULL DEFAULT 'unknown'
                          CHECK (vintage_status IN ('vintage','non_vintage','not_applicable','unknown')),
  age_statement_years   integer,
  volume_ml             integer,
  pack_count            integer NOT NULL DEFAULT 1,
  packaging_type        text NOT NULL DEFAULT 'unknown',
  container_type        text,
  edition               text,
  cask_finish           text,
  dosage_style          text,
  sweetness             text,
  puttony               integer,
  abv_percent           numeric(5,2),
  colour                text,
  region                text,
  country_code          text,
  grape_varieties       text[] NOT NULL DEFAULT '{}',
  attributes            jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Bizonyíték és minőség
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,
  extraction_quality    numeric(4,3) NOT NULL DEFAULT 0.000
                          CHECK (extraction_quality BETWEEN 0 AND 1),
  extractor_key         text,
  extractor_version     text,
  parse_warnings        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Fingerprint és állapot (spec 17.2)
  source_fingerprint    text,     -- a nyers oldal identitás-releváns tartalmából
  identity_hash         text,     -- a strukturált identitásmezőkből
  content_hash          text,

  listing_status        text NOT NULL DEFAULT 'active'
                          CHECK (listing_status IN ('active','missing','redirected','archived','blocked','not_product')),
  availability_status   text NOT NULL DEFAULT 'unknown'
                          CHECK (availability_status IN ('in_stock','out_of_stock','preorder','backorder','discontinued','unknown')),
  cluster_status        text NOT NULL DEFAULT 'unclustered'
                          CHECK (cluster_status IN ('unclustered','searching','clustered','needs_review','rejected_all','drifted')),

  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_checked_at       timestamptz,
  last_successful_extract_at timestamptz,
  missing_since         timestamptz,
  consecutive_failures  integer NOT NULL DEFAULT 0,

  latest_snapshot_id    uuid,
  latest_offer_id       uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Egyediség: elsőként platform ID, ennek hiányában kanonikus URL kulcs (spec 8.6)
CREATE UNIQUE INDEX source_listings_platform_uq
  ON source_listings (shop_id, platform_product_id, coalesce(platform_variant_id, ''))
  WHERE platform_product_id IS NOT NULL;
CREATE UNIQUE INDEX source_listings_urlkey_uq
  ON source_listings (shop_id, url_key)
  WHERE platform_product_id IS NULL;

CREATE INDEX source_listings_shop_idx       ON source_listings (shop_id, listing_status);
CREATE INDEX source_listings_name_trgm      ON source_listings USING gin (normalized_name gin_trgm_ops);
CREATE INDEX source_listings_expr_trgm      ON source_listings USING gin (expression_norm gin_trgm_ops)
  WHERE expression IS NOT NULL;
CREATE INDEX source_listings_fts_idx        ON source_listings USING gin (rv_tsv(raw_name));
CREATE INDEX source_listings_gtin_idx       ON source_listings (gtin_normalized) WHERE gtin_normalized IS NOT NULL;
CREATE INDEX source_listings_sku_idx        ON source_listings (shop_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX source_listings_block_idx      ON source_listings (brand_id, vintage_value, volume_ml, pack_count);
CREATE INDEX source_listings_producer_idx   ON source_listings (producer_id, volume_ml);
CREATE INDEX source_listings_cluster_idx    ON source_listings (cluster_status, shop_id)
  WHERE listing_status = 'active';
CREATE INDEX source_listings_urlkey_idx     ON source_listings (shop_id, url_key);
CREATE TRIGGER source_listings_touch BEFORE UPDATE ON source_listings
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- Késleltetett FK-k a 0004-ből
ALTER TABLE canonical_variants
  ADD CONSTRAINT canonical_variants_origin_listing_fk
  FOREIGN KEY (origin_listing_id) REFERENCES source_listings(id) ON DELETE SET NULL;
ALTER TABLE tracked_products
  ADD CONSTRAINT tracked_products_preferred_listing_fk
  FOREIGN KEY (preferred_source_listing_id) REFERENCES source_listings(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Snapshot: egy konkrét letöltés kinyert eredménye, bizonyítékkal (spec 8.7)
-- ---------------------------------------------------------------------------
CREATE TABLE source_listing_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id          uuid NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  crawl_run_id        uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
  observed_at         timestamptz NOT NULL DEFAULT now(),

  raw_name            text NOT NULL,
  normalized_name     text,
  extracted_fields    jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,

  content_hash        text NOT NULL,
  identity_hash       text NOT NULL,
  source_fingerprint  text,

  extractor_key       text NOT NULL,
  extractor_version   text NOT NULL,
  extraction_method   text,     -- 'platform_api' | 'jsonld' | 'app_state' | 'microdata' | 'dom' | 'ai'
  extraction_quality  numeric(4,3) NOT NULL DEFAULT 0.000,
  parse_warnings      jsonb NOT NULL DEFAULT '[]'::jsonb,
  http_status         integer,
  response_time_ms    integer,
  raw_artifact_ref    text,     -- objektumtár kulcs, csak hiba/review esetén
  ai_used             boolean NOT NULL DEFAULT false,
  ai_model            text,
  ai_prompt_version   text
);
CREATE INDEX snapshots_listing_idx ON source_listing_snapshots (listing_id, observed_at DESC);
CREATE INDEX snapshots_run_idx     ON source_listing_snapshots (crawl_run_id);
CREATE INDEX snapshots_identity_idx ON source_listing_snapshots (listing_id, identity_hash);

ALTER TABLE source_listings
  ADD CONSTRAINT source_listings_latest_snapshot_fk
  FOREIGN KEY (latest_snapshot_id) REFERENCES source_listing_snapshots(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Ajánlat-megfigyelés (spec 8.8, 12.3, 18.2)
-- MINDEN pénzérték egész HUF. A forrás minor unitját külön tároljuk.
-- ---------------------------------------------------------------------------
CREATE TABLE offer_observations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id                uuid NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  crawl_run_id              uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
  snapshot_id               uuid REFERENCES source_listing_snapshots(id) ON DELETE SET NULL,
  observed_at               timestamptz NOT NULL DEFAULT now(),

  currency                  text NOT NULL DEFAULT 'HUF',
  source_minor_unit         integer NOT NULL DEFAULT 0,   -- a forrás által jelzett minor unit
  raw_price_value           text,                          -- a nyers, kiolvasott string

  -- Külön ártípusok (spec 12.3). Mind egész HUF.
  regular_price_huf         bigint CHECK (regular_price_huf IS NULL OR regular_price_huf >= 0),
  sale_price_huf            bigint CHECK (sale_price_huf IS NULL OR sale_price_huf >= 0),
  current_price_huf         bigint CHECK (current_price_huf IS NULL OR current_price_huf >= 0),
  member_price_huf          bigint,
  coupon_price_huf          bigint,
  quantity_price_huf        bigint,
  unit_price_huf            bigint,
  unit_basis                text,     -- 'liter' | 'piece' | '100ml'
  deposit_amount_huf        bigint,

  -- Az összehasonlításba KIZÁRÓLAG ez kerül (spec 18.2)
  selected_comparable_price_huf bigint CHECK (selected_comparable_price_huf IS NULL OR selected_comparable_price_huf > 0),
  price_type                text NOT NULL DEFAULT 'unknown'
                              CHECK (price_type IN ('regular','sale','member','coupon','quantity','unknown','not_comparable')),
  comparable                boolean NOT NULL DEFAULT false,
  not_comparable_reason     text,

  vat_included              boolean,
  in_stock                  boolean,
  availability_raw          text,
  availability_status       text NOT NULL DEFAULT 'unknown'
                              CHECK (availability_status IN ('in_stock','out_of_stock','preorder','backorder','discontinued','unknown')),
  max_orderable_qty         integer,
  valid_from                timestamptz,
  valid_to                  timestamptz,

  observation_status        text NOT NULL DEFAULT 'observed'
                              CHECK (observation_status IN ('observed','out_of_stock','not_orderable','missing','redirected','invalid_price','identity_drift','extraction_incomplete')),
  anomaly_flags             text[] NOT NULL DEFAULT '{}',
  quarantined               boolean NOT NULL DEFAULT false,
  quarantine_reason         text,

  evidence                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offers_listing_time_idx ON offer_observations (listing_id, observed_at DESC);
CREATE INDEX offers_run_idx          ON offer_observations (crawl_run_id);
CREATE INDEX offers_comparable_idx   ON offer_observations (listing_id, observed_at DESC)
  WHERE comparable AND NOT quarantined;
CREATE INDEX offers_anomaly_idx      ON offer_observations (observed_at DESC)
  WHERE quarantined OR array_length(anomaly_flags, 1) > 0;
-- Egy futásban egy listinghez egy megfigyelés (idempotencia, spec 32.5)
CREATE UNIQUE INDEX offers_run_listing_uq
  ON offer_observations (crawl_run_id, listing_id) WHERE crawl_run_id IS NOT NULL;

ALTER TABLE source_listings
  ADD CONSTRAINT source_listings_latest_offer_fk
  FOREIGN KEY (latest_offer_id) REFERENCES offer_observations(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Eseményalapú ártörténet (spec 18.3). Nem minden megfigyelés lesz esemény.
-- ---------------------------------------------------------------------------
CREATE TABLE price_events (
  id                  bigserial PRIMARY KEY,
  listing_id          uuid NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  canonical_variant_id uuid REFERENCES canonical_variants(id) ON DELETE SET NULL,
  observation_id      uuid REFERENCES offer_observations(id) ON DELETE SET NULL,
  event_type          text NOT NULL
                        CHECK (event_type IN ('first_seen','price_changed','availability_changed','sale_started','sale_ended','listing_missing','listing_returned','identity_drift','price_anomaly')),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  previous_price_huf  bigint,
  new_price_huf       bigint,
  delta_huf           bigint,
  delta_pct           numeric(8,3),
  previous_availability text,
  new_availability    text,
  significance        text NOT NULL DEFAULT 'normal'
                        CHECK (significance IN ('normal','significant','extreme')),
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX price_events_listing_idx  ON price_events (listing_id, occurred_at DESC);
CREATE INDEX price_events_variant_idx  ON price_events (canonical_variant_id, occurred_at DESC);
CREATE INDEX price_events_recent_idx   ON price_events (occurred_at DESC, event_type);
CREATE INDEX price_events_significant_idx ON price_events (occurred_at DESC)
  WHERE significance IN ('significant','extreme');
