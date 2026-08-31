-- ============================================================================
-- 0006  Párosítás, döntések, review, negatív memória, keresési memória
-- Spec 8.9, 14.3, 15., 16.3, 17.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Verziózott kapcsolat kanonikus változat <-> webshoplisting (spec 8.9)
-- ---------------------------------------------------------------------------
CREATE TABLE match_relations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_variant_id  uuid NOT NULL REFERENCES canonical_variants(id) ON DELETE CASCADE,
  source_listing_id     uuid NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'proposed'
                          CHECK (status IN ('proposed','verified','rejected','suspended','drifted')),
  decision_origin       text NOT NULL DEFAULT 'auto'
                          CHECK (decision_origin IN ('auto','human','legacy_import','import')),
  verified_kind         text CHECK (verified_kind IN ('auto_verified','human_verified')),
  confidence            numeric(4,3),
  locked_by_human       boolean NOT NULL DEFAULT false,
  identity_hash_at_decision text,
  valid_from            timestamptz NOT NULL DEFAULT now(),
  valid_to              timestamptz,
  current_decision_id   uuid,
  last_verified_at      timestamptz,
  drift_detected_at     timestamptz,
  drift_reason          text,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER match_relations_touch BEFORE UPDATE ON match_relations
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- INTEGRITÁS (spec 8.9):
-- Egy source listingnek legfeljebb EGY aktív verified kanonikus kapcsolata lehet.
CREATE UNIQUE INDEX match_relations_one_verified_per_listing
  ON match_relations (source_listing_id)
  WHERE status = 'verified' AND valid_to IS NULL;
-- Ugyanaz a pár egyszer szerepelhet aktívan.
CREATE UNIQUE INDEX match_relations_pair_uq
  ON match_relations (canonical_variant_id, source_listing_id)
  WHERE valid_to IS NULL;
CREATE INDEX match_relations_variant_idx ON match_relations (canonical_variant_id, status);
CREATE INDEX match_relations_listing_idx ON match_relations (source_listing_id, status);
CREATE INDEX match_relations_shop_idx    ON match_relations (shop_id, status);
CREATE INDEX match_relations_drift_idx   ON match_relations (drift_detected_at DESC)
  WHERE status = 'drifted';

-- ---------------------------------------------------------------------------
-- Döntés: minden párosítási kiértékelés verziózott, magyarázható rekordja
-- ---------------------------------------------------------------------------
CREATE TABLE match_decisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_relation_id     uuid REFERENCES match_relations(id) ON DELETE CASCADE,
  canonical_variant_id  uuid NOT NULL REFERENCES canonical_variants(id) ON DELETE CASCADE,
  source_listing_id     uuid REFERENCES source_listings(id) ON DELETE CASCADE,
  shop_id               uuid REFERENCES shops(id) ON DELETE CASCADE,

  status                text NOT NULL
                          CHECK (status IN ('unsearched','searching','candidate_found','needs_review','auto_verified','human_verified','rejected','ambiguous','insufficient_evidence','not_found_after_full_search','source_unhealthy','mapping_drift','listing_missing','suspended')),

  matcher_version       text NOT NULL,
  taxonomy_version      text NOT NULL,
  policy_version        text NOT NULL,

  candidate_sources     text[] NOT NULL DEFAULT '{}',
  candidate_ranks       jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_results         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- match/contradiction/unknown mezőnként
  hard_contradictions   jsonb NOT NULL DEFAULT '[]'::jsonb,

  agreement_score       numeric(5,4),
  evidence_coverage     numeric(5,4),
  extraction_quality    numeric(5,4),
  retrieval_support     numeric(5,4),
  top_margin            numeric(5,4),
  decision_strength     numeric(5,4),
  contradiction_count   integer NOT NULL DEFAULT 0,
  negative_history      integer NOT NULL DEFAULT 0,

  reason_codes          text[] NOT NULL DEFAULT '{}',
  explanation_hu        text,
  runner_up             jsonb NOT NULL DEFAULT '[]'::jsonb,   -- top 5 alternatíva
  decision_json         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- teljes audit payload

  decided_by            text NOT NULL DEFAULT 'engine'
                          CHECK (decided_by IN ('engine','human','import','system')),
  reviewer_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           timestamptz,
  review_note           text,
  ai_assisted           boolean NOT NULL DEFAULT false,
  ai_model              text,

  crawl_run_id          uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
  correlation_id        text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_decisions_relation_idx ON match_decisions (match_relation_id, created_at DESC);
CREATE INDEX match_decisions_variant_idx  ON match_decisions (canonical_variant_id, created_at DESC);
CREATE INDEX match_decisions_listing_idx  ON match_decisions (source_listing_id, created_at DESC);
CREATE INDEX match_decisions_status_idx   ON match_decisions (status, created_at DESC);

ALTER TABLE match_relations
  ADD CONSTRAINT match_relations_current_decision_fk
  FOREIGN KEY (current_decision_id) REFERENCES match_decisions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Kanonikus változat x webshop keresési státusz (spec 17.1, 25.)
-- Ez mondja meg, hogy egy adott shopban hol tart a keresés.
-- ---------------------------------------------------------------------------
CREATE TABLE variant_shop_status (
  canonical_variant_id  uuid NOT NULL REFERENCES canonical_variants(id) ON DELETE CASCADE,
  shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'unsearched'
                          CHECK (status IN ('unsearched','searching','candidate_found','needs_review','auto_verified','human_verified','rejected','ambiguous','insufficient_evidence','not_found_after_full_search','source_unhealthy','mapping_drift','listing_missing','suspended','search_incomplete')),
  matched_listing_id    uuid REFERENCES source_listings(id) ON DELETE SET NULL,
  last_search_at        timestamptz,
  last_full_search_at   timestamptz,
  search_attempt_count  integer NOT NULL DEFAULT 0,
  consecutive_no_match  integer NOT NULL DEFAULT 0,
  next_search_at        timestamptz,
  best_rejected_score   numeric(5,4),
  primary_reason_code   text,
  reason_codes          text[] NOT NULL DEFAULT '{}',
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_variant_id, shop_id)
);
CREATE INDEX variant_shop_status_shop_idx  ON variant_shop_status (shop_id, status);
CREATE INDEX variant_shop_status_next_idx  ON variant_shop_status (next_search_at)
  WHERE status IN ('not_found_after_full_search','search_incomplete','source_unhealthy','insufficient_evidence');
CREATE TRIGGER variant_shop_status_touch BEFORE UPDATE ON variant_shop_status
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Negatív memória (spec 14.3): elutasított jelöltek fingerprinttel.
-- Azonos fingerprint mellett ugyanaz a jelölt NEM ajánlható fel újra.
-- ---------------------------------------------------------------------------
CREATE TABLE rejected_candidates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_variant_id  uuid NOT NULL REFERENCES canonical_variants(id) ON DELETE CASCADE,
  source_listing_id     uuid NOT NULL REFERENCES source_listings(id) ON DELETE CASCADE,
  shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  rejected_by           text NOT NULL DEFAULT 'engine'
                          CHECK (rejected_by IN ('engine','human','negative_alias')),
  reviewer_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  reason_code           text NOT NULL,
  reason_note           text,
  listing_identity_hash text NOT NULL,
  variant_identity_hash text NOT NULL,
  score_at_rejection    numeric(5,4),
  reopened_at           timestamptz,
  reopen_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rejected_candidates_uq
  ON rejected_candidates (canonical_variant_id, source_listing_id, listing_identity_hash, variant_identity_hash)
  WHERE reopened_at IS NULL;
CREATE INDEX rejected_candidates_variant_idx ON rejected_candidates (canonical_variant_id);
CREATE INDEX rejected_candidates_listing_idx ON rejected_candidates (source_listing_id);

-- ---------------------------------------------------------------------------
-- Keresési memória (spec 16.3): mikor, mivel, milyen úton kerestünk
-- ---------------------------------------------------------------------------
CREATE TABLE search_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_variant_id  uuid REFERENCES canonical_variants(id) ON DELETE CASCADE,
  origin_listing_id     uuid REFERENCES source_listings(id) ON DELETE CASCADE,
  shop_id               uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  crawl_run_id          uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  query_plan            jsonb NOT NULL DEFAULT '[]'::jsonb,
  channels_used         text[] NOT NULL DEFAULT '{}',
  channel_results       jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidates_found      integer NOT NULL DEFAULT 0,
  candidates_after_gate integer NOT NULL DEFAULT 0,
  outcome               text NOT NULL
                          CHECK (outcome IN ('matched','needs_review','not_found','search_incomplete','source_unhealthy','ambiguous','insufficient_evidence','error')),
  source_health_at_time text,
  reason_codes          text[] NOT NULL DEFAULT '{}',
  duration_ms           integer,
  detail                jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (canonical_variant_id IS NOT NULL OR origin_listing_id IS NOT NULL)
);
CREATE INDEX search_attempts_variant_idx ON search_attempts (canonical_variant_id, started_at DESC);
CREATE INDEX search_attempts_listing_idx ON search_attempts (origin_listing_id, started_at DESC);
CREATE INDEX search_attempts_shop_idx    ON search_attempts (shop_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Review case: az emberi döntést igénylő esetek (spec 24.)
-- ---------------------------------------------------------------------------
CREATE TABLE review_cases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_type             text NOT NULL
                          CHECK (case_type IN ('new_match','ambiguous','mapping_drift','price_anomaly','identity_conflict','unclustered_listing','alias_proposal','data_quality','listing_missing')),
  priority              integer NOT NULL DEFAULT 100,
  status                text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in_progress','deferred','resolved','dismissed')),
  canonical_variant_id  uuid REFERENCES canonical_variants(id) ON DELETE CASCADE,
  source_listing_id     uuid REFERENCES source_listings(id) ON DELETE CASCADE,
  shop_id               uuid REFERENCES shops(id) ON DELETE CASCADE,
  match_relation_id     uuid REFERENCES match_relations(id) ON DELETE CASCADE,
  match_decision_id     uuid REFERENCES match_decisions(id) ON DELETE SET NULL,
  observation_id        uuid REFERENCES offer_observations(id) ON DELETE SET NULL,
  alias_id              uuid REFERENCES aliases(id) ON DELETE CASCADE,

  title                 text NOT NULL,
  reason_codes          text[] NOT NULL DEFAULT '{}',
  confidence            numeric(5,4),
  candidates            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- top jelöltek pontszámmal
  context               jsonb NOT NULL DEFAULT '{}'::jsonb,

  assignee_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at                timestamptz,
  deferred_until        timestamptz,
  resolved_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at           timestamptz,
  resolution            text
                          CHECK (resolution IS NULL OR resolution IN ('approved','rejected','candidate_selected','not_found','canonical_fixed','merged','split','alias_promoted','dismissed','auto_resolved')),
  resolution_note       text,
  row_version           integer NOT NULL DEFAULT 1,   -- optimistic locking (spec 19.5)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_cases_open_idx   ON review_cases (priority, created_at) WHERE status IN ('open','in_progress');
CREATE INDEX review_cases_type_idx   ON review_cases (case_type, status);
CREATE INDEX review_cases_shop_idx   ON review_cases (shop_id, status);
CREATE INDEX review_cases_assignee_idx ON review_cases (assignee_user_id, status);
CREATE INDEX review_cases_variant_idx ON review_cases (canonical_variant_id);
CREATE INDEX review_cases_deferred_idx ON review_cases (deferred_until) WHERE status = 'deferred';
-- Ugyanarra a párra egyszerre csak egy nyitott eset
CREATE UNIQUE INDEX review_cases_open_pair_uq
  ON review_cases (case_type, coalesce(canonical_variant_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(source_listing_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('open','in_progress','deferred');
CREATE TRIGGER review_cases_touch BEFORE UPDATE ON review_cases
  FOR EACH ROW EXECUTE FUNCTION rv_touch_updated_at();

CREATE TABLE review_case_events (
  id              bigserial PRIMARY KEY,
  review_case_id  uuid NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  note            text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX review_case_events_case_idx ON review_case_events (review_case_id, occurred_at DESC);
