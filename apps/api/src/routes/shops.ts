/**
 * Webshopok, terméktár és futások (spec 21.3, 21.5, 26., 27.).
 * A RADOVIN itt ugyanolyan webshop, mint barmelyik masik.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { execute, query, queryOne } from '@radovin/db';
import { listAdapters } from '@radovin/adapters';
import { assertSafeUrl, canonicalizeUrl, urlKey } from '@radovin/crawler-core';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import { requireAtLeast } from '../lib/auth.js';
import { audit, pageParams, paginated, safeOrderBy } from '../lib/context.js';
import { enqueue, JOB_PRIORITY, queueStats } from '../lib/queues.js';

const LISTING_SORT: Record<string, string> = {
  name: 'sl.raw_name',
  price: 'o.selected_comparable_price_huf',
  seen: 'sl.last_seen_at',
  first: 'sl.first_seen_at',
  quality: 'sl.extraction_quality',
};

export async function shopRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // ── Webshoplista es egeszseg ─────────────────────────────────────────────
  app.get('/shops', async () => {
    const items = await query('SELECT * FROM v_shop_health ORDER BY sort_order, name');
    return { items };
  });

  app.get('/shops/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const shop = await queryOne('SELECT * FROM v_shop_health WHERE id = $1', [id]);
    if (!shop) throw new AppError('NOT_FOUND', 'A webshop nem talalhato.', 404);
    const config_ = await queryOne(
      `SELECT s.adapter_config, s.discovery_strategy, s.expected_catalog_min, s.expected_catalog_max,
              s.catalog_drop_tolerance_pct, s.robots_allows_crawl, s.robots_last_checked_at,
              s.terms_last_checked_at, s.terms_review_note, s.legal_review_status,
              s.policy_disabled, s.policy_disabled_reason, s.discovery_interval_hours,
              s.price_refresh_interval_hours, s.alternate_hosts,
              cp.key AS policy_key, cp.requests_per_second, cp.max_concurrency,
              cp.request_timeout_ms, cp.max_retries, cp.respect_robots, cp.allow_browser,
              cp.daily_request_budget
         FROM shops s LEFT JOIN crawl_policies cp ON cp.id = s.crawl_policy_id
        WHERE s.id = $1`,
      [id],
    );
    const runs = await query(
      `SELECT id, run_type, status, source_status, started_at, finished_at, duration_ms,
              listings_new, listings_updated, listings_missing, extract_ok, extract_failed,
              catalog_size_after, completeness, quality_gate_passed, quarantine_reason
         FROM crawl_runs WHERE shop_id = $1 ORDER BY started_at DESC LIMIT 20`,
      [id],
    );
    // Bekuldott, de meg el nem indult feladatok. A `crawl_runs` sort a
    // feldolgozo hozza letre, amikor tenylegesen hozzakezd - a sorban allo
    // feladat addig sehol nem latszott, es a felhasznalo joggal hitte, hogy
    // elveszett a kerese. A felderites sorat szandekosan ket parhuzamos job
    // dolgozza fel, ezert a varakozas normalis allapot.
    const pending = await query(
      `SELECT id, queue, job_name, queued_at, priority
         FROM job_runs
        WHERE shop_id = $1 AND status = 'queued'
        ORDER BY queued_at DESC LIMIT 10`,
      [id],
    );
    return { shop, config: config_, recentRuns: runs, pendingJobs: pending };
  });

  app.patch('/shops/:id', async (req) => {
    const actor = requireAtLeast(req.user, 'source_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      active: z.boolean().optional(),
      policyDisabled: z.boolean().optional(),
      policyDisabledReason: z.string().optional(),
      adapterKey: z.string().optional(),
      adapterVersion: z.string().optional(),
      adapterConfig: z.record(z.unknown()).optional(),
      discoveryStrategy: z.string().optional(),
      discoveryIntervalHours: z.number().int().min(1).max(8760).optional(),
      priceRefreshIntervalHours: z.number().int().min(1).max(8760).optional(),
      expectedCatalogMin: z.number().int().nullable().optional(),
      expectedCatalogMax: z.number().int().nullable().optional(),
      legalReviewStatus: z.enum(['pending', 'approved', 'restricted', 'blocked']).optional(),
      termsReviewNote: z.string().optional(),
      crawlPolicyKey: z.string().optional(),
    }).parse(req.body);

    const before = await queryOne('SELECT * FROM shops WHERE id = $1', [id]);
    if (!before) throw new AppError('NOT_FOUND', 'A webshop nem talalhato.', 404);

    const updates: string[] = [];
    const params: unknown[] = [id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };
    if (body.active !== undefined) push('active', body.active);
    if (body.policyDisabled !== undefined) push('policy_disabled', body.policyDisabled);
    if (body.policyDisabledReason !== undefined) push('policy_disabled_reason', body.policyDisabledReason);
    if (body.adapterKey !== undefined) push('adapter_key', body.adapterKey);
    if (body.adapterVersion !== undefined) push('adapter_version', body.adapterVersion);
    if (body.adapterConfig !== undefined) push('adapter_config', JSON.stringify(body.adapterConfig));
    if (body.discoveryStrategy !== undefined) push('discovery_strategy', body.discoveryStrategy);
    if (body.discoveryIntervalHours !== undefined) push('discovery_interval_hours', body.discoveryIntervalHours);
    if (body.priceRefreshIntervalHours !== undefined) push('price_refresh_interval_hours', body.priceRefreshIntervalHours);
    if (body.expectedCatalogMin !== undefined) push('expected_catalog_min', body.expectedCatalogMin);
    if (body.expectedCatalogMax !== undefined) push('expected_catalog_max', body.expectedCatalogMax);
    if (body.legalReviewStatus !== undefined) push('legal_review_status', body.legalReviewStatus);
    if (body.termsReviewNote !== undefined) {
      push('terms_review_note', body.termsReviewNote);
      updates.push('terms_last_checked_at = now()');
    }
    if (body.crawlPolicyKey !== undefined) {
      params.push(body.crawlPolicyKey);
      updates.push(`crawl_policy_id = (SELECT id FROM crawl_policies WHERE key = $${params.length})`);
    }
    if (!updates.length) return { ok: true, changed: 0 };

    await execute(`UPDATE shops SET ${updates.join(', ')} WHERE id = $1`, params);

    // Az `active` jelzo a piaci publikaciot kapuzza: egy inaktiv bolt
    // ajanlatai nem kerulnek ki. Ha ez most valtozott, a piacot ujra kell
    // epiteni - kulonben a felhasznalo aktival, es egy oraig (a scheduler
    // kovetkezo koreig) semmi nem tortenik a fooldalon.
    if (body.active !== undefined && body.active !== (before as { active?: boolean }).active) {
      await enqueue({
        redisUrl: config.REDIS_URL,
        queue: 'aggregate-dashboard', name: 'rebuild',
        payload: { trigger: 'shop_active_changed' },
        idempotencyKey: `aggregate:rebuild:shop:${Math.floor(Date.now() / 30_000)}`,
        delayMs: 10_000,
        correlationId: req.correlationId,
      }).catch(() => undefined);
    }

    await audit({
      actorUserId: actor.id, action: 'shop.updated', entityType: 'shop', entityId: id,
      before, after: body, correlationId: req.correlationId,
    });
    return { ok: true };
  });

  // ── Webshop terméktár (spec 26.) ─────────────────────────────────────────
  app.get('/shops/:id/listings', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({
      q: z.string().optional(),
      cluster: z.enum(['unclustered', 'clustered', 'needs_review', 'rejected_all', 'drifted', 'searching']).optional(),
      status: z.string().optional(),
      inStock: z.enum(['true', 'false']).optional(),
      category: z.string().optional(),
      sort: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const where = ['sl.shop_id = $1'];
    const params: unknown[] = [id];
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(sl.raw_name ILIKE $${params.length} OR sl.sku = trim($${params.length}, '%') OR sl.gtin_normalized = trim($${params.length}, '%'))`);
    }
    if (q.cluster) { params.push(q.cluster); where.push(`sl.cluster_status = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`sl.listing_status = $${params.length}`); }
    if (q.inStock) { params.push(q.inStock === 'true'); where.push(`(o.in_stock IS NOT DISTINCT FROM $${params.length})`); }
    if (q.category) { params.push(q.category); where.push(`pc.key = $${params.length}`); }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const orderBy = safeOrderBy(q.sort, LISTING_SORT, 'sl.last_seen_at DESC');

    const [items, countRow] = await Promise.all([
      query(
        `SELECT sl.id, sl.raw_name, sl.canonical_url, sl.image_url, sl.sku, sl.gtin,
                sl.vintage_value, sl.volume_ml, sl.pack_count, sl.packaging_type,
                sl.expression, sl.extraction_quality, sl.cluster_status, sl.listing_status,
                sl.availability_status, sl.first_seen_at, sl.last_seen_at, sl.last_checked_at,
                pc.key AS category_key, pc.name_hu AS category_name,
                o.selected_comparable_price_huf AS price_huf, o.regular_price_huf,
                o.price_type, o.comparable, o.observed_at,
                mr.canonical_variant_id, mr.status AS match_status, cv.canonical_display_name
           FROM source_listings sl
           LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
           LEFT JOIN product_categories pc ON pc.id = sl.category_id
           LEFT JOIN match_relations mr ON mr.source_listing_id = sl.id
                 AND mr.status = 'verified' AND mr.valid_to IS NULL
           LEFT JOIN canonical_variants cv ON cv.id = mr.canonical_variant_id
           ${whereSql}
          ORDER BY ${orderBy}
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM source_listings sl
           LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
           LEFT JOIN product_categories pc ON pc.id = sl.category_id
           ${whereSql}`,
        params,
      ),
    ]);
    return paginated(items, countRow?.total ?? 0, p);
  });

  /**
   * Webshopkozpontu osszehasonlitas (spec V2.1, 23.2).
   * A kivalasztott webshop MINDEN termekere megmutatja, mennyibe kerul
   * ugyanaz a valtozat a tobbi webshopban.
   */
  app.get('/shops/:id/catalog-comparison', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({
      q: z.string().optional(),
      category: z.string().optional(),
      position: z.enum(['cheapest', 'not_cheapest', 'only_offer', 'no_match']).optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
      sort: z.string().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const where = ['anchor.shop_id = $1'];
    const params: unknown[] = [id];
    if (q.q) { params.push(`%${q.q}%`); where.push(`cv.canonical_display_name ILIKE $${params.length}`); }
    if (q.category) { params.push(q.category); where.push(`pc.key = $${params.length}`); }
    if (q.position === 'cheapest') where.push('anchor.rank_in_market = 1');
    if (q.position === 'not_cheapest') where.push('anchor.rank_in_market > 1');
    if (q.position === 'only_offer') where.push('ms.shop_count = 1');

    const sortMap: Record<string, string> = {
      name: 'cv.canonical_display_name',
      price: 'anchor.price_huf',
      rank: 'anchor.rank_in_market',
      delta: 'anchor.delta_to_min_pct',
      offers: 'ms.shop_count',
    };
    const orderBy = safeOrderBy(q.sort, sortMap, 'anchor.delta_to_min_pct DESC NULLS LAST');
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [items, countRow] = await Promise.all([
      query(
        `SELECT cv.id AS canonical_variant_id, cv.canonical_display_name,
                cv.vintage_value, cv.volume_ml, cv.pack_count, cv.packaging_type,
                pc.key AS category_key, pc.name_hu AS category_name,
                anchor.price_huf AS anchor_price_huf,
                anchor.rank_in_market AS anchor_rank,
                anchor.rank_denominator,
                anchor.delta_to_min_huf, anchor.delta_to_min_pct,
                anchor.delta_to_median_huf, anchor.delta_to_median_pct,
                anchor.on_sale AS anchor_on_sale, anchor.stale AS anchor_stale,
                anchor.product_url AS anchor_url, anchor.listing_name AS anchor_listing_name,
                anchor.observed_at AS anchor_observed_at,
                ms.min_price_huf, ms.median_price_huf, ms.max_price_huf,
                ms.shop_count, ms.offer_count, ms.spread_pct, ms.data_quality,
                (SELECT json_agg(json_build_object(
                    'shopId', other.shop_id, 'shopKey', other.shop_key, 'shopName', other.shop_name,
                    'shopColor', other.shop_color, 'priceHuf', other.price_huf,
                    'rank', other.rank_in_market, 'onSale', other.on_sale, 'stale', other.stale,
                    'inStock', other.in_stock, 'url', other.product_url,
                    'deltaVsAnchorHuf', other.price_huf - anchor.price_huf,
                    'deltaVsAnchorPct', round(((other.price_huf - anchor.price_huf)::numeric / NULLIF(anchor.price_huf,0)) * 100, 2),
                    'observedAt', other.observed_at, 'matchStatus', other.match_status)
                    ORDER BY other.price_huf)
                   FROM v_market_offers other
                  WHERE other.canonical_variant_id = cv.id AND other.shop_id <> $1) AS other_offers
           FROM v_market_offers anchor
           JOIN canonical_variants cv ON cv.id = anchor.canonical_variant_id
           JOIN product_families pf ON pf.id = cv.product_family_id
           JOIN product_categories pc ON pc.id = pf.category_id
           LEFT JOIN v_current_publication pub ON true
           LEFT JOIN market_variant_summary ms
                  ON ms.canonical_variant_id = cv.id AND ms.publication_id = pub.id
           ${whereSql}
          ORDER BY ${orderBy}
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM v_market_offers anchor
           JOIN canonical_variants cv ON cv.id = anchor.canonical_variant_id
           JOIN product_families pf ON pf.id = cv.product_family_id
           JOIN product_categories pc ON pc.id = pf.category_id
           LEFT JOIN v_current_publication pub ON true
           LEFT JOIN market_variant_summary ms
                  ON ms.canonical_variant_id = cv.id AND ms.publication_id = pub.id
           ${whereSql}`,
        params,
      ),
    ]);

    return paginated(items, countRow?.total ?? 0, p);
  });

  // ── Egy listing es kornyezete ────────────────────────────────────────────
  app.get('/source-listings/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const listing = await queryOne(
      `SELECT sl.*, s.key AS shop_key, s.name AS shop_name, s.brand_color, s.health_status,
              pc.key AS category_key, pc.name_hu AS category_name,
              o.selected_comparable_price_huf AS price_huf, o.regular_price_huf, o.sale_price_huf,
              o.member_price_huf, o.unit_price_huf, o.price_type, o.comparable,
              o.not_comparable_reason, o.observed_at, o.anomaly_flags, o.quarantined,
              mr.canonical_variant_id, mr.status AS match_status, mr.decision_origin,
              cv.canonical_display_name
         FROM source_listings sl
         JOIN shops s ON s.id = sl.shop_id
         LEFT JOIN product_categories pc ON pc.id = sl.category_id
         LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
         LEFT JOIN match_relations mr ON mr.source_listing_id = sl.id AND mr.valid_to IS NULL AND mr.status = 'verified'
         LEFT JOIN canonical_variants cv ON cv.id = mr.canonical_variant_id
        WHERE sl.id = $1`,
      [id],
    );
    if (!listing) throw new AppError('NOT_FOUND', 'A listing nem talalhato.', 404);
    const snapshots = await query(
      `SELECT id, observed_at, raw_name, extraction_quality, extraction_method,
              extractor_version, identity_hash, content_hash, parse_warnings, http_status
         FROM source_listing_snapshots WHERE listing_id = $1
        ORDER BY observed_at DESC LIMIT 20`,
      [id],
    );
    return { listing, snapshots };
  });

  app.get('/source-listings/:id/history', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [offers, events] = await Promise.all([
      query(
        `SELECT observed_at, selected_comparable_price_huf AS price_huf, regular_price_huf,
                sale_price_huf, price_type, in_stock, availability_status, comparable,
                anomaly_flags, quarantined
           FROM offer_observations WHERE listing_id = $1
          ORDER BY observed_at DESC LIMIT 500`,
        [id],
      ),
      query('SELECT * FROM price_events WHERE listing_id = $1 ORDER BY occurred_at DESC LIMIT 200', [id]),
    ]);
    return { offers, events };
  });

  /** Egy listing osszes igazolt megfeleloje mas webshopokban (spec V2.1). */
  app.get('/source-listings/:id/equivalent-offers', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const relation = await queryOne<{ canonical_variant_id: string }>(
      `SELECT canonical_variant_id FROM match_relations
        WHERE source_listing_id = $1 AND status = 'verified' AND valid_to IS NULL`,
      [id],
    );
    if (!relation) {
      const candidates = await query(
        `SELECT rc.id, rc.title, rc.status, rc.candidates, rc.reason_codes, rc.created_at
           FROM review_cases rc WHERE rc.source_listing_id = $1 ORDER BY rc.created_at DESC LIMIT 5`,
        [id],
      );
      return {
        clustered: false,
        canonicalVariantId: null,
        offers: [],
        pendingReviews: candidates,
        message: 'Ez a listing meg nincs kanonikus klaszterhez kapcsolva. A keresés folyamatban vagy felulvizsgalatot igenyel.',
      };
    }
    const offers = await query(
      'SELECT * FROM v_market_offers WHERE canonical_variant_id = $1 ORDER BY price_huf',
      [relation.canonical_variant_id],
    );
    return { clustered: true, canonicalVariantId: relation.canonical_variant_id, offers };
  });

  app.post('/source-listings/:id/search-equivalents', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const job = await enqueue({
      redisUrl: config.REDIS_URL, queue: 'candidate-generation', name: 'cluster-listing',
      payload: { sourceListingId: id, trigger: 'manual' },
      idempotencyKey: `cluster:${id}`,
      priority: JOB_PRIORITY['manual-search'], correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'listing.search_equivalents', entityType: 'source_listing',
      entityId: id, correlationId: req.correlationId,
    });
    return { accepted: true, jobId: job.jobId, deduped: job.deduped, state: job.state, waiting: job.waiting };
  });

  /**
   * Konkret URL ellenorzese (spec 24.3). SSRF-vedett: csak http/https es
   * kizarolag a rendszerben regisztralt webshopok hostjai.
   */
  app.post('/source-listings/fetch-url', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const body = z.object({
      url: z.string().url(),
      canonicalVariantId: z.string().uuid().optional(),
    }).parse(req.body);

    const hosts = await query<{ canonical_host: string; alternate_hosts: string[]; id: string; key: string }>(
      'SELECT id, key, canonical_host, alternate_hosts FROM shops WHERE active',
    );
    const allowlist = hosts.flatMap((h) => [h.canonical_host, ...(h.alternate_hosts ?? [])]);

    let parsed: URL;
    try {
      parsed = await assertSafeUrl(body.url, { hostAllowlist: allowlist });
    } catch (err) {
      throw new AppError(
        'URL_NOT_ALLOWED',
        `Az URL nem tolthetó le: ${err instanceof Error ? err.message : String(err)}. Csak a rendszerben regisztralt webshopok hostjai engedelyezettek.`,
        400,
      );
    }
    const host = parsed.hostname.toLowerCase();
    const shop = hosts.find(
      (h) => host === h.canonical_host.toLowerCase() || (h.alternate_hosts ?? []).some((a) => host === a.toLowerCase()),
    );
    if (!shop) throw new AppError('UNKNOWN_SHOP', 'Az URL nem tartozik egyetlen regisztralt webshophoz sem.', 400);

    const job = await enqueue({
      redisUrl: config.REDIS_URL, queue: 'listing-extract', name: 'fetch-single-url',
      payload: {
        url: canonicalizeUrl(parsed.toString()),
        urlKey: urlKey(parsed.toString()),
        shopId: shop.id,
        canonicalVariantId: body.canonicalVariantId ?? null,
        trigger: 'review',
      },
      idempotencyKey: `fetch-url:${urlKey(parsed.toString())}`,
      priority: JOB_PRIORITY['review-url-check'],
      shopId: shop.id, correlationId: req.correlationId,
    });

    await audit({
      actorUserId: actor.id, action: 'listing.fetch_url', entityType: 'source_listing',
      summary: parsed.toString(), metadata: { shopKey: shop.key }, correlationId: req.correlationId,
    });
    return { accepted: true, jobId: job.jobId, deduped: job.deduped, state: job.state, waiting: job.waiting, shopId: shop.id, shopKey: shop.key };
  });

  // ── Crawl muveletek (spec 21.5) ──────────────────────────────────────────
  app.post('/shops/:id/discovery-runs', async (req) => {
    const actor = requireAtLeast(req.user, 'source_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const shop = await queryOne<{ key: string; active: boolean; policy_disabled: boolean; adapter_key: string }>(
      'SELECT key, active, policy_disabled, adapter_key FROM shops WHERE id = $1', [id],
    );
    if (!shop) throw new AppError('NOT_FOUND', 'A webshop nem talalhato.', 404);
    if (shop.policy_disabled) {
      throw new AppError('POLICY_DISABLED', 'A forras jogi/policy okbol le van tiltva (policy_disabled).', 409);
    }
    const running = await queryOne<{ id: string }>(
      `SELECT id FROM crawl_runs WHERE shop_id = $1 AND run_type = 'discovery' AND status = 'running'`, [id],
    );
    if (running) {
      throw new AppError('RUN_IN_PROGRESS', 'Mar fut discovery ezen a webshopon.', 409, { runId: running.id });
    }

    const browser = shop.adapter_key === 'browser-jsonld';
    const job = await enqueue({
      redisUrl: config.REDIS_URL,
      queue: browser ? 'shop-discovery-browser' : 'shop-discovery-http',
      name: 'discovery',
      payload: { shopId: id, trigger: 'manual', actorUserId: actor.id },
      idempotencyKey: `discovery:${id}`,
      priority: JOB_PRIORITY['shop-discovery'],
      shopId: id, correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'shop.discovery_triggered', entityType: 'shop', entityId: id,
      summary: `Kezi discovery inditva: ${shop.key}`, correlationId: req.correlationId,
    });
    return {
      accepted: true, jobId: job.jobId, deduped: job.deduped,
      // A felderites sorat szandekosan 2 parhuzamos job dolgozza fel, ezert egy
      // bekuldott feladat simán varhat. A felulet enelkul "elindult"-at irt.
      state: job.state, waiting: job.waiting,
    };
  });

  app.post('/shops/:id/health-check', async (req) => {
    const actor = requireAtLeast(req.user, 'source_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const job = await enqueue({
      redisUrl: config.REDIS_URL, queue: 'shop-discovery-http', name: 'health-check',
      payload: { shopId: id, trigger: 'manual' },
      idempotencyKey: `health:${id}`, priority: 2, shopId: id, correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'shop.health_check', entityType: 'shop', entityId: id,
      correlationId: req.correlationId,
    });
    return { accepted: true, jobId: job.jobId, deduped: job.deduped, state: job.state, waiting: job.waiting };
  });

  app.post('/shops/:id/price-refresh', async (req) => {
    const actor = requireAtLeast(req.user, 'source_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const job = await enqueue({
      redisUrl: config.REDIS_URL, queue: 'known-listing-refresh', name: 'refresh-shop',
      payload: { shopId: id, trigger: 'manual' },
      idempotencyKey: `refresh:${id}`,
      priority: JOB_PRIORITY['known-listing-refresh'], shopId: id, correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'shop.price_refresh', entityType: 'shop', entityId: id,
      correlationId: req.correlationId,
    });
    return { accepted: true, jobId: job.jobId, deduped: job.deduped, state: job.state, waiting: job.waiting };
  });

  // ── Futasok (spec 27.2) ──────────────────────────────────────────────────
  app.get('/crawl-runs', async (req) => {
    const q = z.object({
      shopId: z.string().uuid().optional(),
      status: z.string().optional(),
      runType: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.shopId) { params.push(q.shopId); where.push(`r.shop_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}`); }
    if (q.runType) { params.push(q.runType); where.push(`r.run_type = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [items, countRow] = await Promise.all([
      query(
        `SELECT r.*, s.key AS shop_key, s.name AS shop_name, s.brand_color
           FROM crawl_runs r JOIN shops s ON s.id = r.shop_id
           ${whereSql} ORDER BY r.started_at DESC
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM crawl_runs r ${whereSql}`, params),
    ]);
    return paginated(items, countRow?.total ?? 0, p);
  });

  app.get('/crawl-runs/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const run = await queryOne(
      `SELECT r.*, s.key AS shop_key, s.name AS shop_name
         FROM crawl_runs r JOIN shops s ON s.id = r.shop_id WHERE r.id = $1`,
      [id],
    );
    if (!run) throw new AppError('NOT_FOUND', 'A futas nem talalhato.', 404);
    const [jobs, previous] = await Promise.all([
      query(
        `SELECT id, queue, job_name, status, attempt, error_code, error_message,
                queued_at, started_at, finished_at, duration_ms
           FROM job_runs WHERE crawl_run_id = $1 ORDER BY queued_at DESC LIMIT 200`,
        [id],
      ),
      queryOne(
        `SELECT id, started_at, listings_new, listings_updated, listings_missing,
                catalog_size_after, extract_ok, extract_failed, status
           FROM crawl_runs
          WHERE shop_id = (SELECT shop_id FROM crawl_runs WHERE id = $1)
            AND run_type = (SELECT run_type FROM crawl_runs WHERE id = $1)
            AND started_at < (SELECT started_at FROM crawl_runs WHERE id = $1)
          ORDER BY started_at DESC LIMIT 1`,
        [id],
      ),
    ]);
    return { run, jobs, previousRun: previous };
  });

  // ── Job muveletek ────────────────────────────────────────────────────────
  app.get('/jobs/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const job = await queryOne(
      'SELECT * FROM job_runs WHERE id::text = $1 OR external_job_id = $1 ORDER BY queued_at DESC LIMIT 1', [id],
    );
    if (!job) throw new AppError('NOT_FOUND', 'A job nem talalhato.', 404);
    return { job };
  });

  app.get('/queues', async (req) => {
    requireAtLeast(req.user, 'source_manager');
    return { queues: await queueStats(config.REDIS_URL) };
  });

  app.get('/adapters', async (req) => {
    requireAtLeast(req.user, 'source_manager');
    return { items: listAdapters() };
  });
}
