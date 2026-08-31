-- ============================================================================
-- 0007  Piaci aggregátum, atomikus publikáció, import, jobok, riasztás
-- Spec 18.5, 19., 30., 31.2, 9.3, 35.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Publikációs generáció: az atomikus csere alapja (spec 31.2)
-- Az UI mindig az utolsó 'published' generációt olvassa.
-- ---------------------------------------------------------------------------
CREATE TABLE market_publications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation          bigint NOT NULL,
  status              text NOT NULL DEFAULT 'building'
                        CHECK (status IN ('building','published','quarantined','superseded','failed')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  published_at        timestamptz,
  variants_total      integer NOT NULL DEFAULT 0,
  offers_total        integer NOT NULL DEFAULT 0,
  shops_included      integer NOT NULL DEFAULT 0,
  shops_stale         text[] NOT NULL DEFAULT '{}',
  quality_gate_passed boolean,
  quality_gate_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  quarantine_reason   text,
  matcher_version     text,
  correlation_id      text
);
CREATE UNIQUE INDEX market_publications_generation_uq ON market_publications (generation);
CREATE UNIQUE INDEX market_publications_one_published ON market_publications ((true)) WHERE status = 'published';
CREATE INDEX market_publications_status_idx ON market_publications (status, started_at DESC);

-- ---------------------------------------------------------------------------
-- Egy kanonikus változat egy webshopban KIVÁLASZTOTT összehasonlítható ajánlata.
-- Webshoponként legfeljebb egy sor (spec 8.9, 18.5, 31.2).
-- ---------------------------------------------------------------------------
CREATE TABLE market_offers (
  publication_id        uuid NOT NULL REFERENCES market_publications(id) ON DELETE CASCADE,
  canonical_variant_id  uuid NOT NULL REFERENCES canonical_variants(id) ON DELETE CASCADE,
  shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  source_listing_id     uuid NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  observation_id        uuid REFERENCES offer_observations(id) ON DELETE SET NULL,
  price_huf             bigint NOT NULL CHECK (price_huf > 0),
  regular_price_huf     bigint,
  price_type            text NOT NULL,
  on_sale               boolean NOT NULL DEFAULT false,
  in_stock              boolean,
  availability_status   text,
  match_status          text NOT NULL,
  match_confidence      numeric(5,4),
  decision_origin       text NOT NULL,
  observed_at           timestamptz NOT NULL,
  last_checked_at       timestamptz,
  freshness_hours       numeric(10,2),
  stale                 boolean NOT NULL DEFAULT false,
  rank_in_market        integer,
  rank_denominator      integer,
  tied                  boolean NOT NULL DEFAULT false,
  delta_to_min_huf      bigint,
  delta_to_min_pct      numeric(8,3),
  delta_to_median_huf   bigint,
  delta_to_median_pct   numeric(8,3),
  product_url           text NOT NULL,
  PRIMARY KEY (publication_id, canonical_variant_id, shop_id)
);
CREATE INDEX market_offers_variant_idx ON market_offers (publication_id, canonical_variant_id);
CREATE INDEX market_offers_shop_idx    ON market_offers (publication_id, shop_id, rank_in_market);
CREATE INDEX market_offers_listing_idx ON market_offers (source_listing_id);

-- ---------------------------------------------------------------------------
-- Termékszintű piaci összegzés (a mátrix sorai)
-- ---------------------------------------------------------------------------
CREATE TABLE market_variant_summary (
  publication_id        uuid NOT NULL REFERENCES market_publications(id) ON DELETE CASCADE,
  canonical_variant_id  uuid NOT NULL REFERENCES canonical_variants(id) ON DELETE CASCADE,
  offer_count           integer NOT NULL DEFAULT 0,
  shop_count            integer NOT NULL DEFAULT 0,
  min_price_huf         bigint,
  max_price_huf         bigint,
  median_price_huf      bigint,
  avg_price_huf         bigint,
  spread_huf            bigint,
  spread_pct            numeric(8,3),
  min_shop_id           uuid REFERENCES shops(id) ON DELETE SET NULL,
  max_shop_id           uuid REFERENCES shops(id) ON DELETE SET NULL,
  any_on_sale           boolean NOT NULL DEFAULT false,
  any_stale             boolean NOT NULL DEFAULT false,
  data_quality          text NOT NULL DEFAULT 'ok'
                          CHECK (data_quality IN ('ok','partial','provisional','degraded')),
  missing_shop_ids      uuid[] NOT NULL DEFAULT '{}',
  last_change_at        timestamptz,
  PRIMARY KEY (publication_id, canonical_variant_id)
);
CREATE INDEX market_variant_summary_offers_idx ON market_variant_summary (publication_id, offer_count DESC);
CREATE INDEX market_variant_summary_spread_idx ON market_variant_summary (publication_id, spread_pct DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- Import (spec 9.3)
-- ---------------------------------------------------------------------------
CREATE TABLE import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename          text,
  source_kind       text NOT NULL DEFAULT 'csv'
                      CHECK (source_kind IN ('csv','xlsx','url_list','manual','legacy_migration','shop_catalog')),
  status            text NOT NULL DEFAULT 'uploaded'
                      CHECK (status IN ('uploaded','mapping','validating','validated','committing','committed','failed','cancelled')),
  column_mapping    jsonb NOT NULL DEFAULT '{}'::jsonb,
  options           jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_rows        integer NOT NULL DEFAULT 0,
  valid_rows        integer NOT NULL DEFAULT 0,
  warning_rows      integer NOT NULL DEFAULT 0,
  error_rows        integer NOT NULL DEFAULT 0,
  duplicate_rows    integer NOT NULL DEFAULT 0,
  created_variants  integer NOT NULL DEFAULT 0,
  created_families  integer NOT NULL DEFAULT 0,
  created_tracked   integer NOT NULL DEFAULT 0,
  uploaded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  committed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  committed_at      timestamptz,
  error_summary     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER import_batches_touch BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

CREATE TABLE import_rows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number        integer NOT NULL,
  raw               jsonb NOT NULL,
  parsed            jsonb NOT NULL DEFAULT '{}'::jsonb,
  extracted_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','valid','warning','error','duplicate','skipped','committed')),
  messages          jsonb NOT NULL DEFAULT '[]'::jsonb,
  duplicate_of      uuid REFERENCES canonical_variants(id) ON DELETE SET NULL,
  created_variant_id uuid REFERENCES canonical_variants(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_rows_uq ON import_rows (batch_id, row_number);
CREATE INDEX import_rows_status_idx ON import_rows (batch_id, status);

-- ---------------------------------------------------------------------------
-- Job futások (a BullMQ mellé tartós, lekérdezhető audit)
-- ---------------------------------------------------------------------------
CREATE TABLE job_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue           text NOT NULL,
  job_name        text NOT NULL,
  external_job_id text,
  idempotency_key text,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','cancelled','dead_letter')),
  priority        integer NOT NULL DEFAULT 100,
  attempt         integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 3,
  shop_id         uuid REFERENCES shops(id) ON DELETE CASCADE,
  crawl_run_id    uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  result          jsonb,
  error_code      text,
  error_message   text,
  correlation_id  text,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  duration_ms     integer
);
CREATE UNIQUE INDEX job_runs_idempotency_uq ON job_runs (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('queued','running','succeeded');
CREATE INDEX job_runs_queue_idx  ON job_runs (queue, status, queued_at DESC);
CREATE INDEX job_runs_shop_idx   ON job_runs (shop_id, queued_at DESC);
CREATE INDEX job_runs_failed_idx ON job_runs (finished_at DESC) WHERE status IN ('failed','dead_letter');

-- ---------------------------------------------------------------------------
-- Riasztások (spec 30.3) - aggregált, cselekvésre alkalmas
-- ---------------------------------------------------------------------------
CREATE TABLE alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key       text NOT NULL,          -- dedup kulcs
  level           text NOT NULL CHECK (level IN ('info','warn','error','critical')),
  category        text NOT NULL
                    CHECK (category IN ('crawler','matching','pricing','quality_gate','queue','security','backup','system')),
  title           text NOT NULL,
  message         text NOT NULL,
  shop_id         uuid REFERENCES shops(id) ON DELETE CASCADE,
  entity_type     text,
  entity_id       text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrence_count integer NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  dispatched_at   timestamptz
);
CREATE UNIQUE INDEX alerts_open_key_uq ON alerts (alert_key) WHERE resolved_at IS NULL;
CREATE INDEX alerts_open_idx ON alerts (level, last_seen_at DESC) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Metrika-idősor (egyszerű, Postgres-natív; nem helyettesít Prometheust)
-- ---------------------------------------------------------------------------
CREATE TABLE metric_samples (
  id            bigserial PRIMARY KEY,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  metric        text NOT NULL,
  shop_id       uuid REFERENCES shops(id) ON DELETE CASCADE,
  labels        jsonb NOT NULL DEFAULT '{}'::jsonb,
  value         double precision NOT NULL
);
CREATE INDEX metric_samples_idx ON metric_samples (metric, recorded_at DESC);
CREATE INDEX metric_samples_shop_idx ON metric_samples (shop_id, metric, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- Golden dataset (spec 32.1) - a matching bizonyításának alapja
-- ---------------------------------------------------------------------------
CREATE TABLE golden_pairs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 text NOT NULL CHECK (label IN ('positive','hard_negative','no_match')),
  category_key          text,
  case_group            text,           -- pl. 'vintage', 'volume', 'gift_box', 'pack', 'edition'
  left_kind             text NOT NULL CHECK (left_kind IN ('canonical_variant','source_listing','fixture')),
  left_ref              text NOT NULL,
  right_kind            text NOT NULL CHECK (right_kind IN ('canonical_variant','source_listing','fixture','none')),
  right_ref             text,
  left_payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  right_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_reason_codes text[] NOT NULL DEFAULT '{}',
  notes                 text,
  verified_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at           timestamptz,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX golden_pairs_label_idx ON golden_pairs (label, category_key) WHERE active;

CREATE TABLE golden_evaluations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at              timestamptz NOT NULL DEFAULT now(),
  matcher_version     text NOT NULL,
  policy_version      text NOT NULL,
  total_pairs         integer NOT NULL,
  precision_auto      numeric(6,4),
  precision_ci_low    numeric(6,4),
  precision_ci_high   numeric(6,4),
  recall_auto         numeric(6,4),
  false_positives     integer NOT NULL DEFAULT 0,
  false_negatives     integer NOT NULL DEFAULT 0,
  candidate_recall_5  numeric(6,4),
  candidate_recall_10 numeric(6,4),
  hard_negative_pass  numeric(6,4),
  by_category         jsonb NOT NULL DEFAULT '{}'::jsonb,
  by_shop             jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold_curve     jsonb NOT NULL DEFAULT '[]'::jsonb,
  report              jsonb NOT NULL DEFAULT '{}'::jsonb,
  passed              boolean NOT NULL DEFAULT false
);
CREATE INDEX golden_evaluations_idx ON golden_evaluations (run_at DESC);

-- ---------------------------------------------------------------------------
-- Mentett felhasználói szűrők (spec 22.2)
-- ---------------------------------------------------------------------------
CREATE TABLE saved_views (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope         text NOT NULL,       -- 'dashboard' | 'review' | 'catalog' | ...
  name          text NOT NULL,
  filters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX saved_views_uq ON saved_views (user_id, scope, name);
