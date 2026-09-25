-- ─────────────────────────────────────────────────────────────────────────────
-- A sopres nem porghet ugyanazon a soron, es a dontesi naplo nem ismetel.
--
-- 2026-09-25, meresbol: a `match_decisions` 22 nap alatt 38 GB-ra nott, es
-- ezzel a szerver lemezenek felet elfoglalta.
--
--   utolso 24 ora            413 851 uj dontesi sor
--   ebbol kulonbozo listing      297
--   kulonbozo eredmeny           297   (minden ismetles pontos masolat)
--
-- A mechanizmus: a scheduler percenkent sopor, es az elso 300 `unclustered`
-- listinget veszi, rogzitett sorrendben. Aminel a motor nem tud donteni (nincs
-- eleg bizonyitek, vagy a valtozat abban a boltban mar egy MASIK listinggel
-- igazolt, tehat eset sem nyilik), az kiertekeles utan visszaesik
-- `unclustered`-be - es egy perc mulva ugyanaz jon elo, ugyanazzal az
-- eredmennyel, egy uj ~4 KB-os dontesi sorral. Mogotte 10 447 listing sosem
-- kerult sorra.
--
-- ─── Mit tesz ez a migracio ──────────────────────────────────────────────────
--
--  1. `source_listings.cluster_retry_at`: a sopres ezt a listinget ELOTTE nem
--     veszi elo. A klaszterezo job allitja be, ha a listing a kiertekeles
--     utan is `unclustered` maradt.
--  2. `cluster_sweep_backlog` nezet: a hatralek EGYETLEN definicioja. Eddig
--     negy helyen (sopres, utemezo, Folyamatkezeles, pipeline-check) allt
--     ugyanaz a lekerdezes kezzel masolva, es egyszer mar elcsuszott.
--  3. `match_decisions.seen_count` / `last_seen_at`: ha a motor ugyanarra a
--     parra PONTOSAN ugyanazt donti, nem uj sor keletkezik, hanem a meglevo
--     szamlaloja no. A tortenet igy is olvashato: mikor dontott eloszor, hanyszor
--     erositette meg, mikor utoljara.
--  4. A hurok karanak javitasa a `variant_shop_status`-ban (lent).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE source_listings ADD COLUMN IF NOT EXISTS cluster_retry_at timestamptz;

CREATE OR REPLACE VIEW cluster_sweep_backlog AS
SELECT sl.id, sl.shop_id, s.key AS shop_key, s.segment AS shop_segment, sl.producer_id
  FROM source_listings sl
  JOIN shops s ON s.id = sl.shop_id
 WHERE sl.listing_status = 'active'
   AND sl.cluster_status = 'unclustered'
   AND s.active AND NOT s.policy_disabled
   AND (sl.cluster_retry_at IS NULL OR sl.cluster_retry_at <= now())
   -- Aminek MAR van ervenyes igazolt kanonikus parja, azon nincs mit
   -- klaszterezni (lasd d4d7a1d: ez dugta be a sor elejet szeptember 16-an).
   AND NOT EXISTS (
     SELECT 1 FROM match_relations mr
      WHERE mr.source_listing_id = sl.id
        AND mr.status = 'verified' AND mr.valid_to IS NULL);

-- Konstans alapertek: a Postgres 11+ ezt metaadatkent tarolja, a tablat nem
-- irja at - egy nagy tablan is azonnali.
ALTER TABLE match_decisions
  ADD COLUMN IF NOT EXISTS seen_count   integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- ─── A hurok kara a `variant_shop_status`-ban ────────────────────────────────
--
-- A klaszterezo kiertekeles a (valtozat, bolt) par allapotat is irta. Ha a
-- valtozat abban a boltban mar igazolt volt egy MASIK listinggel, a masodik
-- listing percenkenti kiertekelese a part `needs_review`-ra vagy
-- `insufficient_evidence`-re allitotta, `matched_listing_id` nelkul - holott
-- a par igazolt. A termeklap es a szamlalok ezt mutattak.
--
-- Csak ott allitjuk vissza, ahol a par legutobbi dontese NEM az igazolt
-- listingrol szolt. Ha maga az igazolt listing kapott gyengebb dontest, az
-- valodi jelzes, ahhoz nem nyulunk.
UPDATE variant_shop_status vss
   SET status = CASE WHEN mr.verified_kind = 'human_verified' OR mr.decision_origin = 'human'
                     THEN 'human_verified' ELSE 'auto_verified' END,
       matched_listing_id   = mr.source_listing_id,
       consecutive_no_match = 0,
       next_search_at       = now() + interval '7 days'
  FROM match_relations mr
 WHERE mr.canonical_variant_id = vss.canonical_variant_id
   AND mr.shop_id = vss.shop_id
   AND mr.status = 'verified' AND mr.valid_to IS NULL
   AND vss.status IN ('needs_review', 'insufficient_evidence', 'ambiguous')
   AND (SELECT md.source_listing_id
          FROM match_decisions md
         WHERE md.canonical_variant_id = vss.canonical_variant_id
           AND md.shop_id = vss.shop_id
         ORDER BY md.created_at DESC
         LIMIT 1) IS DISTINCT FROM mr.source_listing_id;
