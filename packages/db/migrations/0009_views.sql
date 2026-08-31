-- ============================================================================
-- 0009  Olvasási nézetek: az API és a dashboard ezekre épül.
-- Minden nézet az AKTUÁLISAN PUBLIKÁLT generációt olvassa (spec 31.2).
-- ============================================================================

-- Az aktuálisan publikált piaci generáció
CREATE OR REPLACE VIEW v_current_publication AS
SELECT * FROM market_publications WHERE status = 'published';

-- Aktuális, összehasonlítható ajánlatok webshop- és termékadattal
CREATE OR REPLACE VIEW v_market_offers AS
SELECT
  mo.canonical_variant_id,
  mo.shop_id,
  s.key           AS shop_key,
  s.name          AS shop_name,
  s.brand_color   AS shop_color,
  s.health_status AS shop_health,
  mo.source_listing_id,
  mo.observation_id,
  mo.price_huf,
  mo.regular_price_huf,
  mo.price_type,
  mo.on_sale,
  mo.in_stock,
  mo.availability_status,
  mo.match_status,
  mo.match_confidence,
  mo.decision_origin,
  mo.observed_at,
  mo.last_checked_at,
  mo.freshness_hours,
  mo.stale,
  mo.rank_in_market,
  mo.rank_denominator,
  mo.tied,
  mo.delta_to_min_huf,
  mo.delta_to_min_pct,
  mo.delta_to_median_huf,
  mo.delta_to_median_pct,
  mo.product_url,
  sl.raw_name     AS listing_name,
  sl.image_url    AS listing_image
FROM market_offers mo
JOIN v_current_publication p ON p.id = mo.publication_id
JOIN shops s              ON s.id = mo.shop_id
JOIN source_listings sl   ON sl.id = mo.source_listing_id;

-- Termékszintű piaci összegzés a katalógusadatokkal együtt
CREATE OR REPLACE VIEW v_market_variants AS
SELECT
  cv.id                     AS canonical_variant_id,
  cv.canonical_display_name,
  cv.vintage_value,
  cv.vintage_status,
  cv.age_statement_years,
  cv.volume_ml,
  cv.pack_count,
  cv.packaging_type,
  cv.edition,
  cv.abv_percent,
  cv.gtin,
  cv.status                 AS variant_status,
  cv.identity_hash,
  pf.id                     AS product_family_id,
  pf.canonical_name         AS family_name,
  pf.product_line,
  pf.region,
  pf.origin_country,
  pf.colour,
  pf.grape_varieties,
  pc.key                    AS category_key,
  pc.name_hu                AS category_name,
  pc.kind                   AS category_kind,
  br.canonical_name         AS brand_name,
  pr.canonical_name         AS producer_name,
  tp.id IS NOT NULL         AS tracked,
  tp.priority               AS tracking_priority,
  ms.offer_count,
  ms.shop_count,
  ms.min_price_huf,
  ms.max_price_huf,
  ms.median_price_huf,
  ms.avg_price_huf,
  ms.spread_huf,
  ms.spread_pct,
  ms.min_shop_id,
  ms.max_shop_id,
  ms.any_on_sale,
  ms.any_stale,
  ms.data_quality,
  ms.last_change_at
FROM canonical_variants cv
JOIN product_families pf   ON pf.id = cv.product_family_id
JOIN product_categories pc ON pc.id = pf.category_id
LEFT JOIN brands br        ON br.id = pf.brand_id
LEFT JOIN producers pr     ON pr.id = pf.producer_id
LEFT JOIN tracked_products tp ON tp.canonical_variant_id = cv.id AND tp.active
LEFT JOIN v_current_publication p ON true
LEFT JOIN market_variant_summary ms
       ON ms.canonical_variant_id = cv.id AND ms.publication_id = p.id
WHERE cv.status IN ('active','proposed');

-- Webshop-egészség összegzés a kártyákhoz (spec 27.1)
CREATE OR REPLACE VIEW v_shop_health AS
SELECT
  s.id, s.key, s.name, s.base_url, s.segment, s.active, s.policy_disabled,
  s.adapter_key, s.adapter_version, s.health_status, s.health_checked_at,
  s.legal_review_status, s.brand_color, s.sort_order,
  s.last_successful_discovery_at, s.last_price_refresh_at,
  s.next_discovery_at, s.next_price_refresh_at,
  s.expected_catalog_min, s.expected_catalog_max,
  (SELECT count(*) FROM source_listings sl
    WHERE sl.shop_id = s.id AND sl.listing_status = 'active')                    AS listings_active,
  (SELECT count(*) FROM source_listings sl
    WHERE sl.shop_id = s.id AND sl.cluster_status = 'clustered')                 AS listings_clustered,
  (SELECT count(*) FROM source_listings sl
    WHERE sl.shop_id = s.id AND sl.cluster_status = 'unclustered'
      AND sl.listing_status = 'active')                                          AS listings_unclustered,
  (SELECT count(*) FROM match_relations mr
    WHERE mr.shop_id = s.id AND mr.status = 'verified' AND mr.valid_to IS NULL)  AS verified_matches,
  (SELECT count(*) FROM review_cases rc
    WHERE rc.shop_id = s.id AND rc.status IN ('open','in_progress'))             AS open_reviews,
  (SELECT r.id FROM crawl_runs r
    WHERE r.shop_id = s.id ORDER BY r.started_at DESC LIMIT 1)                   AS last_run_id,
  (SELECT r.status FROM crawl_runs r
    WHERE r.shop_id = s.id ORDER BY r.started_at DESC LIMIT 1)                   AS last_run_status,
  (SELECT r.started_at FROM crawl_runs r
    WHERE r.shop_id = s.id ORDER BY r.started_at DESC LIMIT 1)                   AS last_run_at
FROM shops s;

-- Nem talált / hiányzó párok felülete (spec 25.)
CREATE OR REPLACE VIEW v_unmatched AS
SELECT
  vss.canonical_variant_id,
  vss.shop_id,
  vss.status,
  vss.last_search_at,
  vss.last_full_search_at,
  vss.search_attempt_count,
  vss.consecutive_no_match,
  vss.next_search_at,
  vss.best_rejected_score,
  vss.primary_reason_code,
  vss.reason_codes,
  cv.canonical_display_name,
  cv.vintage_value,
  cv.volume_ml,
  pc.key   AS category_key,
  s.name   AS shop_name,
  s.key    AS shop_key,
  s.health_status,
  CASE
    WHEN vss.status = 'not_found_after_full_search' AND s.health_status = 'ok' THEN 'healthy_not_found'
    WHEN vss.status IN ('source_unhealthy','search_incomplete') THEN 'technical'
    WHEN vss.status IN ('needs_review','ambiguous','insufficient_evidence') THEN 'uncertain_candidate'
    WHEN vss.status = 'listing_missing' THEN 'listing_gone'
    WHEN vss.status = 'rejected' THEN 'all_rejected'
    ELSE 'other'
  END AS bucket
FROM variant_shop_status vss
JOIN canonical_variants cv ON cv.id = vss.canonical_variant_id
JOIN product_families pf   ON pf.id = cv.product_family_id
JOIN product_categories pc ON pc.id = pf.category_id
JOIN shops s               ON s.id = vss.shop_id
WHERE vss.status NOT IN ('auto_verified','human_verified');
