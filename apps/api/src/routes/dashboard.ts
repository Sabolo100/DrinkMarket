/**
 * Dashboard, osszehasonlito matrix, arvaltozasok, nem talalt termekek,
 * export (spec 21.6, 23., 25.).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '@radovin/db';
import { REASON_CODE_HU } from '@radovin/contracts';
import type { AppConfig } from '../config.js';
import { pageParams, paginated, safeOrderBy } from '../lib/context.js';
import { toCsv, toXlsx } from '../lib/export.js';

export async function dashboardRoutes(app: FastifyInstance, _config: AppConfig): Promise<void> {
  // ── Osszefoglalo kartyak (spec 23.1) ────────────────────────────────────
  app.get('/dashboard/summary', async (req) => {
    const q = z.object({ anchorShopId: z.string().uuid().optional() }).parse(req.query);

    const [general, publication, shops] = await Promise.all([
      queryOne<Record<string, number>>(
        `SELECT
           -- A katalogus TENYLEGES merete. Az active emberi jovahagyast
           -- jelent, amit a gepi felfedezes sosem ad - a fooldal fo szama
           -- ezert allandoan 0 volt, holott huszezer valtozat volt bent.
           (SELECT count(*)::int FROM canonical_variants WHERE status <> 'merged')                      AS variants_total,
           (SELECT count(*)::int FROM canonical_variants WHERE status = 'active')                       AS variants_active,
           (SELECT count(*)::int FROM canonical_variants WHERE status = 'proposed')                     AS variants_proposed,
           (SELECT count(*)::int FROM market_variant_summary ms
              JOIN v_current_publication p ON p.id = ms.publication_id
             WHERE ms.shop_count >= 2)                                                                  AS variants_multi_shop,
           (SELECT count(*)::int FROM market_variant_summary ms
              JOIN v_current_publication p ON p.id = ms.publication_id
             WHERE ms.shop_count = 1)                                                                   AS variants_single_shop,
           (SELECT count(*)::int FROM source_listings
             WHERE cluster_status = 'unclustered' AND listing_status = 'active')                         AS listings_unclustered,
           (SELECT count(*)::int FROM review_cases WHERE status IN ('open','in_progress'))              AS reviews_open,
           (SELECT count(*)::int FROM review_cases
             WHERE status IN ('open','in_progress') AND case_type = 'mapping_drift')                     AS reviews_drift,
           (SELECT count(*)::int FROM shops
             WHERE active AND health_status IN ('failing','blocked','degraded'))                         AS shops_unhealthy,
           (SELECT count(*)::int FROM price_events
             WHERE occurred_at > now() - interval '7 days'
               AND significance IN ('significant','extreme'))                                            AS price_changes_7d,
           (SELECT count(*)::int FROM alerts WHERE resolved_at IS NULL AND level IN ('error','critical')) AS alerts_open,
           (SELECT count(*)::int FROM source_listings WHERE listing_status = 'active')                    AS listings_total,
           (SELECT count(*)::int FROM tracked_products WHERE active)                                      AS tracked_products`,
      ),
      queryOne(
        `SELECT id, generation, published_at, variants_total, offers_total,
                shops_included, shops_stale, quality_gate_passed
           FROM v_current_publication`,
      ),
      query(
        `SELECT id, key, name, brand_color, health_status, active, policy_disabled,
                last_successful_discovery_at, last_price_refresh_at,
                listings_active, listings_clustered, verified_matches, open_reviews
           FROM v_shop_health ORDER BY sort_order`,
      ),
    ]);

    // Webshopkozpontu nezet, ha van kivalasztott kiindulo webshop
    let anchor = null;
    if (q.anchorShopId) {
      anchor = await queryOne(
        `WITH anchor_offers AS (
           SELECT mo.* FROM v_market_offers mo WHERE mo.shop_id = $1
         )
         SELECT
           (SELECT count(*)::int FROM source_listings
             WHERE shop_id = $1 AND listing_status = 'active')                       AS listings_active,
           (SELECT count(*)::int FROM anchor_offers)                                  AS comparable_products,
           (SELECT count(*)::int FROM anchor_offers WHERE rank_denominator >= 2)      AS with_other_shop_offer,
           (SELECT count(*)::int FROM anchor_offers WHERE rank_in_market = 1)         AS cheapest_count,
           (SELECT count(*)::int FROM anchor_offers WHERE rank_in_market > 1)         AS not_cheapest_count,
           (SELECT count(*)::int FROM anchor_offers WHERE rank_denominator = 1)       AS only_offer_count,
           (SELECT round(avg(delta_to_min_pct)::numeric, 2) FROM anchor_offers
             WHERE rank_denominator >= 2)                                             AS avg_delta_to_min_pct,
           (SELECT round(
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_to_min_pct))::numeric, 2)
              FROM anchor_offers WHERE rank_denominator >= 2)                          AS median_delta_to_min_pct,
           (SELECT count(*)::int FROM variant_shop_status
             WHERE shop_id = $1 AND status = 'not_found_after_full_search')            AS not_found_count,
           (SELECT count(*)::int FROM review_cases
             WHERE shop_id = $1 AND status IN ('open','in_progress'))                  AS open_reviews,
           (SELECT count(*)::int FROM source_listings
             WHERE shop_id = $1 AND cluster_status = 'unclustered'
               AND listing_status = 'active')                                          AS unclustered`,
        [q.anchorShopId],
      );
    }

    return { general, publication, shops, anchor, anchorShopId: q.anchorShopId ?? null };
  });

  // ── Osszehasonlito matrix (spec 23.2) ───────────────────────────────────
  app.get('/dashboard/comparison-matrix', async (req) => {
    const q = z.object({
      q: z.string().optional(),
      category: z.string().optional(),
      shopId: z.string().uuid().optional(),
      anchorShopId: z.string().uuid().optional(),
      vintage: z.coerce.number().optional(),
      volumeMl: z.coerce.number().optional(),
      minShops: z.coerce.number().optional(),
      minSpreadPct: z.coerce.number().optional(),
      matchStatus: z.string().optional(),
      onlyChanged: z.enum(['true', 'false']).optional(),
      onlyReview: z.enum(['true', 'false']).optional(),
      inStock: z.enum(['true', 'false']).optional(),
      maxAgeHours: z.coerce.number().optional(),
      tracked: z.enum(['true', 'false']).optional(),
      sort: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>, 40, 200);

    const where: string[] = ['v.offer_count IS NOT NULL AND v.offer_count > 0'];
    const params: unknown[] = [];
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(v.canonical_display_name ILIKE $${params.length}
                   OR v.family_name ILIKE $${params.length}
                   OR v.brand_name ILIKE $${params.length}
                   OR v.producer_name ILIKE $${params.length})`);
    }
    if (q.category) where.push(`v.category_key = $${params.push(q.category)}`);
    if (q.vintage !== undefined) where.push(`v.vintage_value = $${params.push(q.vintage)}`);
    if (q.volumeMl !== undefined) where.push(`v.volume_ml = $${params.push(q.volumeMl)}`);
    if (q.minShops !== undefined) where.push(`v.shop_count >= $${params.push(q.minShops)}`);
    if (q.minSpreadPct !== undefined) where.push(`v.spread_pct >= $${params.push(q.minSpreadPct)}`);
    if (q.tracked === 'true') where.push('v.tracked');
    if (q.shopId) {
      where.push(`EXISTS (SELECT 1 FROM v_market_offers mo
                           WHERE mo.canonical_variant_id = v.canonical_variant_id
                             AND mo.shop_id = $${params.push(q.shopId)})`);
    }
    if (q.anchorShopId) {
      where.push(`EXISTS (SELECT 1 FROM v_market_offers mo
                           WHERE mo.canonical_variant_id = v.canonical_variant_id
                             AND mo.shop_id = $${params.push(q.anchorShopId)})`);
    }
    if (q.onlyChanged === 'true') {
      where.push(`EXISTS (SELECT 1 FROM price_events pe
                           WHERE pe.canonical_variant_id = v.canonical_variant_id
                             AND pe.occurred_at > now() - interval '7 days'
                             AND pe.event_type = 'price_changed')`);
    }
    if (q.onlyReview === 'true') {
      where.push(`EXISTS (SELECT 1 FROM review_cases rc
                           WHERE rc.canonical_variant_id = v.canonical_variant_id
                             AND rc.status IN ('open','in_progress'))`);
    }

    const sortMap: Record<string, string> = {
      name: 'v.canonical_display_name',
      shops: 'v.shop_count',
      min: 'v.min_price_huf',
      median: 'v.median_price_huf',
      max: 'v.max_price_huf',
      spread: 'v.spread_pct',
      updated: 'v.last_change_at',
    };
    const orderBy = safeOrderBy(q.sort, sortMap, 'v.shop_count DESC, v.canonical_display_name ASC');
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const anchorParam = q.anchorShopId ? params.push(q.anchorShopId) : null;

    const [items, countRow, shopColumns] = await Promise.all([
      query(
        `SELECT v.canonical_variant_id, v.canonical_display_name, v.category_key, v.category_name,
                v.vintage_value, v.vintage_status, v.age_statement_years, v.volume_ml,
                v.pack_count, v.packaging_type, v.brand_name, v.producer_name, v.tracked,
                v.offer_count, v.shop_count, v.min_price_huf, v.max_price_huf,
                v.median_price_huf, v.spread_huf, v.spread_pct, v.any_on_sale, v.any_stale,
                v.data_quality, v.last_change_at,
                (SELECT json_object_agg(mo.shop_key, json_build_object(
                    'shopId', mo.shop_id, 'priceHuf', mo.price_huf,
                    'regularPriceHuf', mo.regular_price_huf, 'onSale', mo.on_sale,
                    'rank', mo.rank_in_market, 'denominator', mo.rank_denominator,
                    'tied', mo.tied, 'inStock', mo.in_stock, 'stale', mo.stale,
                    'matchStatus', mo.match_status, 'matchConfidence', mo.match_confidence,
                    'decisionOrigin', mo.decision_origin, 'url', mo.product_url,
                    'observedAt', mo.observed_at, 'freshnessHours', mo.freshness_hours,
                    'deltaToMinHuf', mo.delta_to_min_huf, 'deltaToMinPct', mo.delta_to_min_pct,
                    'deltaToMedianPct', mo.delta_to_median_pct,
                    'listingName', mo.listing_name, 'shopHealth', mo.shop_health))
                   FROM v_market_offers mo
                  WHERE mo.canonical_variant_id = v.canonical_variant_id) AS cells
                ${anchorParam ? `,
                (SELECT row_to_json(a) FROM (
                   SELECT mo.price_huf, mo.rank_in_market, mo.rank_denominator,
                          mo.delta_to_min_huf, mo.delta_to_min_pct, mo.delta_to_median_pct,
                          mo.on_sale, mo.stale, mo.product_url
                     FROM v_market_offers mo
                    WHERE mo.canonical_variant_id = v.canonical_variant_id
                      AND mo.shop_id = $${anchorParam}) a) AS anchor` : ''}
           FROM v_market_variants v
           ${whereSql}
          ORDER BY ${orderBy}
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM v_market_variants v ${whereSql}`, params),
      query(
        `SELECT id, key, name, brand_color, health_status,
                (SELECT count(*)::int FROM v_market_offers mo WHERE mo.shop_id = s.id) AS offer_count
           FROM shops s WHERE active ORDER BY sort_order, name`,
      ),
    ]);

    return { ...paginated(items, countRow?.total ?? 0, p), shopColumns, anchorShopId: q.anchorShopId ?? null };
  });

  // ── Webshopkozpontu osszehasonlitas (spec V2.1) ─────────────────────────
  app.get('/dashboard/shop-comparison', async (req) => {
    const q = z.object({ anchorShopId: z.string().uuid() }).parse(req.query);
    const [shop, distribution, extremes] = await Promise.all([
      queryOne('SELECT * FROM v_shop_health WHERE id = $1', [q.anchorShopId]),
      query(
        `SELECT rank_in_market AS rank, count(*)::int AS count
           FROM v_market_offers WHERE shop_id = $1 AND rank_denominator >= 2
          GROUP BY rank_in_market ORDER BY rank_in_market`,
        [q.anchorShopId],
      ),
      query(
        `SELECT mo.canonical_variant_id, cv.canonical_display_name, mo.price_huf,
                mo.rank_in_market, mo.rank_denominator, mo.delta_to_min_huf, mo.delta_to_min_pct,
                mo.product_url,
                (SELECT json_build_object('shopName', m2.shop_name, 'priceHuf', m2.price_huf, 'url', m2.product_url)
                   FROM v_market_offers m2
                  WHERE m2.canonical_variant_id = mo.canonical_variant_id
                  ORDER BY m2.price_huf LIMIT 1) AS cheapest
           FROM v_market_offers mo
           JOIN canonical_variants cv ON cv.id = mo.canonical_variant_id
          WHERE mo.shop_id = $1 AND mo.rank_denominator >= 2
          ORDER BY mo.delta_to_min_pct DESC NULLS LAST
          LIMIT 25`,
        [q.anchorShopId],
      ),
    ]);
    return { shop, rankDistribution: distribution, mostExpensiveVsMarket: extremes };
  });

  // ── Arvaltozasok (spec 22.1/6) ──────────────────────────────────────────
  app.get('/dashboard/changes', async (req) => {
    const q = z.object({
      days: z.coerce.number().int().min(1).max(90).default(7),
      shopId: z.string().uuid().optional(),
      significance: z.enum(['normal', 'significant', 'extreme']).optional(),
      eventType: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const where = [`pe.occurred_at > now() - ($1 || ' days')::interval`];
    const params: unknown[] = [String(q.days)];
    if (q.shopId) where.push(`sl.shop_id = $${params.push(q.shopId)}`);
    if (q.significance) where.push(`pe.significance = $${params.push(q.significance)}`);
    if (q.eventType) where.push(`pe.event_type = $${params.push(q.eventType)}`);
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [items, countRow] = await Promise.all([
      query(
        `SELECT pe.id, pe.event_type, pe.occurred_at, pe.previous_price_huf, pe.new_price_huf,
                pe.delta_huf, pe.delta_pct, pe.significance, pe.detail,
                sl.id AS listing_id, sl.raw_name AS listing_name, sl.canonical_url, sl.image_url,
                s.key AS shop_key, s.name AS shop_name, s.brand_color,
                cv.id AS canonical_variant_id, cv.canonical_display_name
           FROM price_events pe
           JOIN source_listings sl ON sl.id = pe.listing_id
           JOIN shops s ON s.id = sl.shop_id
           LEFT JOIN canonical_variants cv ON cv.id = pe.canonical_variant_id
           ${whereSql}
          ORDER BY pe.occurred_at DESC
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(
        `SELECT count(*)::int AS total FROM price_events pe
           JOIN source_listings sl ON sl.id = pe.listing_id ${whereSql}`,
        params,
      ),
    ]);
    return paginated(items, countRow?.total ?? 0, p);
  });

  // ── Nem talalt termekek (spec 25.) ──────────────────────────────────────
  app.get('/dashboard/unmatched', async (req) => {
    const q = z.object({
      shopId: z.string().uuid().optional(),
      anchorShopId: z.string().uuid().optional(),
      bucket: z.enum(['healthy_not_found', 'technical', 'uncertain_candidate', 'listing_gone', 'all_rejected', 'other']).optional(),
      category: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const where: string[] = [];
    const params: unknown[] = [];
    if (q.shopId) where.push(`u.shop_id = $${params.push(q.shopId)}`);
    if (q.bucket) where.push(`u.bucket = $${params.push(q.bucket)}`);
    if (q.category) where.push(`u.category_key = $${params.push(q.category)}`);
    if (q.anchorShopId) {
      // Kiindulo webshop x celwebshop nezet: csak azok a termekek, amelyek a
      // kiindulo webshopban leteznek
      where.push(`EXISTS (SELECT 1 FROM v_market_offers mo
                           WHERE mo.canonical_variant_id = u.canonical_variant_id
                             AND mo.shop_id = $${params.push(q.anchorShopId)})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [items, countRow, buckets] = await Promise.all([
      query(
        `SELECT u.*,
                (SELECT json_agg(json_build_object(
                    'startedAt', sa.started_at, 'outcome', sa.outcome,
                    'channels', sa.channels_used, 'candidates', sa.candidates_found,
                    'reasonCodes', sa.reason_codes) ORDER BY sa.started_at DESC)
                   FROM (SELECT * FROM search_attempts sa2
                          WHERE sa2.canonical_variant_id = u.canonical_variant_id
                            AND sa2.shop_id = u.shop_id
                          ORDER BY sa2.started_at DESC LIMIT 5) sa) AS recent_searches
           FROM v_unmatched u
           ${whereSql}
          ORDER BY u.status, u.last_search_at DESC NULLS LAST
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM v_unmatched u ${whereSql}`, params),
      query(`SELECT bucket, count(*)::int AS count FROM v_unmatched GROUP BY bucket ORDER BY count DESC`),
    ]);

    return { ...paginated(items, countRow?.total ?? 0, p), buckets, reasonLabels: REASON_CODE_HU };
  });

  // ── Forras-egeszseg (spec 21.6) ─────────────────────────────────────────
  app.get('/dashboard/source-health', async () => {
    const [shops, runs, alerts] = await Promise.all([
      query('SELECT * FROM v_shop_health ORDER BY sort_order'),
      query(
        `SELECT DISTINCT ON (shop_id) shop_id, id, run_type, status, source_status,
                started_at, finished_at, quality_gate_passed, quarantine_reason,
                catalog_size_after, completeness
           FROM crawl_runs ORDER BY shop_id, started_at DESC`,
      ),
      query(
        `SELECT a.*, s.key AS shop_key, s.name AS shop_name
           FROM alerts a LEFT JOIN shops s ON s.id = a.shop_id
          WHERE a.resolved_at IS NULL ORDER BY
            CASE a.level WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
            a.last_seen_at DESC LIMIT 100`,
      ),
    ]);
    return { shops, latestRuns: runs, alerts };
  });

  // ── Export (spec 21.6) ──────────────────────────────────────────────────
  app.get('/reports/export', async (req, reply) => {
    const q = z.object({
      format: z.enum(['csv', 'xlsx']).default('xlsx'),
      scope: z.enum(['comparison', 'unmatched', 'changes']).default('comparison'),
      anchorShopId: z.string().uuid().optional(),
      category: z.string().optional(),
    }).parse(req.query);

    let rows: Array<Record<string, unknown>> = [];
    let sheetName = 'Osszehasonlitas';

    if (q.scope === 'comparison') {
      const shops = await query<{ key: string; name: string }>(
        'SELECT key, name FROM shops WHERE active ORDER BY sort_order',
      );
      const data = await query<Record<string, unknown>>(
        `SELECT v.canonical_display_name, v.category_name, v.brand_name, v.producer_name,
                v.vintage_value, v.volume_ml, v.pack_count, v.packaging_type,
                v.shop_count, v.min_price_huf, v.median_price_huf, v.max_price_huf,
                v.spread_huf, v.spread_pct, v.data_quality,
                (SELECT json_object_agg(mo.shop_key, mo.price_huf)
                   FROM v_market_offers mo
                  WHERE mo.canonical_variant_id = v.canonical_variant_id) AS prices
           FROM v_market_variants v
          WHERE v.offer_count > 0
            ${q.category ? 'AND v.category_key = $1' : ''}
          ORDER BY v.canonical_display_name`,
        q.category ? [q.category] : [],
      );
      rows = data.map((r) => {
        const prices = (r['prices'] ?? {}) as Record<string, number>;
        const base: Record<string, unknown> = {
          'Kanonikus nev': r['canonical_display_name'],
          'Kategoria': r['category_name'],
          'Marka': r['brand_name'],
          'Termelo': r['producer_name'],
          'Evjarat': r['vintage_value'],
          'Kiszereles (ml)': r['volume_ml'],
          'Darabszam': r['pack_count'],
          'Csomagolas': r['packaging_type'],
          'Webshopok szama': r['shop_count'],
          'Legolcsobb (Ft)': r['min_price_huf'],
          'Median (Ft)': r['median_price_huf'],
          'Legdragabb (Ft)': r['max_price_huf'],
          'Szoras (Ft)': r['spread_huf'],
          'Szoras (%)': r['spread_pct'],
          'Adatminoseg': r['data_quality'],
        };
        for (const shop of shops) base[shop.name] = prices[shop.key] ?? null;
        return base;
      });
    } else if (q.scope === 'unmatched') {
      sheetName = 'Nem talalt';
      const data = await query<Record<string, unknown>>(
        `SELECT canonical_display_name, category_key, vintage_value, volume_ml,
                shop_name, status, bucket, last_search_at, last_full_search_at,
                search_attempt_count, primary_reason_code, next_search_at
           FROM v_unmatched ORDER BY shop_name, canonical_display_name`,
      );
      rows = data.map((r) => ({
        'Kanonikus nev': r['canonical_display_name'],
        'Kategoria': r['category_key'],
        'Evjarat': r['vintage_value'],
        'Kiszereles (ml)': r['volume_ml'],
        'Webshop': r['shop_name'],
        'Statusz': r['status'],
        'Csoport': r['bucket'],
        'Utolso kereses': r['last_search_at'],
        'Utolso teljes kereses': r['last_full_search_at'],
        'Probalkozasok': r['search_attempt_count'],
        'Fo indok': REASON_CODE_HU[String(r['primary_reason_code'])] ?? r['primary_reason_code'],
        'Kovetkezo kereses': r['next_search_at'],
      }));
    } else {
      sheetName = 'Arvaltozasok';
      const data = await query<Record<string, unknown>>(
        `SELECT pe.occurred_at, pe.event_type, pe.previous_price_huf, pe.new_price_huf,
                pe.delta_huf, pe.delta_pct, pe.significance,
                s.name AS shop_name, sl.raw_name, cv.canonical_display_name
           FROM price_events pe
           JOIN source_listings sl ON sl.id = pe.listing_id
           JOIN shops s ON s.id = sl.shop_id
           LEFT JOIN canonical_variants cv ON cv.id = pe.canonical_variant_id
          WHERE pe.occurred_at > now() - interval '30 days'
          ORDER BY pe.occurred_at DESC LIMIT 20000`,
      );
      rows = data.map((r) => ({
        'Idopont': r['occurred_at'],
        'Esemeny': r['event_type'],
        'Webshop': r['shop_name'],
        'Kanonikus nev': r['canonical_display_name'],
        'Webshop terméknev': r['raw_name'],
        'Elozo ar (Ft)': r['previous_price_huf'],
        'Uj ar (Ft)': r['new_price_huf'],
        'Valtozas (Ft)': r['delta_huf'],
        'Valtozas (%)': r['delta_pct'],
        'Jelentoseg': r['significance'],
      }));
    }

    const stamp = new Date().toISOString().slice(0, 10);
    if (q.format === 'csv') {
      const csv = toCsv(rows);
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="radovin-${q.scope}-${stamp}.csv"`);
      return reply.send(csv);
    }
    const xlsx = toXlsx(rows, sheetName);
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', `attachment; filename="radovin-${q.scope}-${stamp}.xlsx"`);
    return reply.send(xlsx);
  });
}
