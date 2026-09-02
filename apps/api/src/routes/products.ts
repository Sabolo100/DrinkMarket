/**
 * Kanonikus termekek es figyelolista (spec 21.2).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { execute, query, queryOne, transaction } from '@radovin/db';
import { identityHash, resolveIdentityProfile } from '@radovin/domain';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import { requireAtLeast, requireRole } from '../lib/auth.js';
import { audit, pageParams, paginated, safeOrderBy } from '../lib/context.js';
import { enqueue, JOB_PRIORITY } from '../lib/queues.js';

const listQuery = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  shopId: z.string().uuid().optional(),
  status: z.string().optional(),
  tracked: z.enum(['true', 'false']).optional(),
  minOffers: z.coerce.number().int().optional(),
  vintage: z.coerce.number().int().optional(),
  volumeMl: z.coerce.number().int().optional(),
  sort: z.string().optional(),
  page: z.coerce.number().int().optional(),
  pageSize: z.coerce.number().int().optional(),
});

const SORTABLE: Record<string, string> = {
  name: 'v.canonical_display_name',
  offers: 'v.offer_count',
  min: 'v.min_price_huf',
  median: 'v.median_price_huf',
  spread: 'v.spread_pct',
  updated: 'v.last_change_at',
  category: 'v.category_key',
};

export async function productRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // ── Lista ────────────────────────────────────────────────────────────────
  app.get('/products', async (req) => {
    const q = listQuery.parse(req.query);
    const p = pageParams(q as Record<string, unknown>);
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.q) {
      params.push(`%${q.q}%`, q.q);
      where.push(`(
        v.canonical_display_name ILIKE $${params.length - 1}
        OR v.family_name ILIKE $${params.length - 1}
        OR v.brand_name ILIKE $${params.length - 1}
        OR v.producer_name ILIKE $${params.length - 1}
        OR v.gtin = $${params.length}
        OR rv_search_norm(v.canonical_display_name) % rv_search_norm($${params.length})
      )`);
    }
    if (q.category) { params.push(q.category); where.push(`v.category_key = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`v.variant_status = $${params.length}`); }
    if (q.tracked === 'true') where.push('v.tracked');
    if (q.tracked === 'false') where.push('NOT v.tracked');
    if (q.minOffers !== undefined) { params.push(q.minOffers); where.push(`coalesce(v.offer_count,0) >= $${params.length}`); }
    if (q.vintage !== undefined) { params.push(q.vintage); where.push(`v.vintage_value = $${params.length}`); }
    if (q.volumeMl !== undefined) { params.push(q.volumeMl); where.push(`v.volume_ml = $${params.length}`); }
    if (q.shopId) {
      params.push(q.shopId);
      where.push(`EXISTS (SELECT 1 FROM v_market_offers mo
                           WHERE mo.canonical_variant_id = v.canonical_variant_id
                             AND mo.shop_id = $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = safeOrderBy(q.sort, SORTABLE, 'v.canonical_display_name ASC');

    const [items, countRow] = await Promise.all([
      query(
        `SELECT v.*,
                (SELECT json_agg(json_build_object(
                    'shopId', mo.shop_id, 'shopKey', mo.shop_key, 'shopName', mo.shop_name,
                    'shopColor', mo.shop_color, 'priceHuf', mo.price_huf, 'onSale', mo.on_sale,
                    'rank', mo.rank_in_market, 'stale', mo.stale, 'inStock', mo.in_stock,
                    'matchStatus', mo.match_status, 'url', mo.product_url,
                    'observedAt', mo.observed_at, 'deltaToMinPct', mo.delta_to_min_pct)
                    ORDER BY mo.price_huf)
                   FROM v_market_offers mo
                  WHERE mo.canonical_variant_id = v.canonical_variant_id) AS offers
           FROM v_market_variants v
           ${whereSql}
          ORDER BY ${orderBy}
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(
        `SELECT count(*)::int AS total FROM v_market_variants v ${whereSql}`, params,
      ),
    ]);

    return paginated(items, countRow?.total ?? 0, p);
  });

  // ── Egy termek ───────────────────────────────────────────────────────────
  app.get('/products/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const variant = await queryOne(
      `SELECT v.*, cv.identity_profile_json, cv.comparison_policy_json, cv.evidence,
              cv.origin, cv.approved_at, cv.created_at, cv.version,
              pc.identity_profile AS category_identity_profile,
              pc.comparison_policy AS category_comparison_policy
         FROM v_market_variants v
         JOIN canonical_variants cv ON cv.id = v.canonical_variant_id
         JOIN product_families pf ON pf.id = cv.product_family_id
         JOIN product_categories pc ON pc.id = pf.category_id
        WHERE v.canonical_variant_id = $1`,
      [id],
    );
    if (!variant) throw new AppError('NOT_FOUND', 'A termek nem talalhato.', 404);

    const [offers, listings, shopStatus, events] = await Promise.all([
      query(`SELECT * FROM v_market_offers WHERE canonical_variant_id = $1 ORDER BY price_huf`, [id]),
      query(
        `SELECT mr.id AS relation_id, mr.status, mr.decision_origin, mr.confidence,
                mr.locked_by_human, mr.last_verified_at, mr.drift_detected_at, mr.drift_reason,
                sl.id AS listing_id, sl.raw_name, sl.canonical_url, sl.image_url,
                sl.availability_status, sl.extraction_quality, sl.last_checked_at,
                s.id AS shop_id, s.key AS shop_key, s.name AS shop_name, s.brand_color,
                o.selected_comparable_price_huf, o.regular_price_huf, o.price_type,
                o.comparable, o.not_comparable_reason, o.observed_at
           FROM match_relations mr
           JOIN source_listings sl ON sl.id = mr.source_listing_id
           JOIN shops s ON s.id = mr.shop_id
           LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
          WHERE mr.canonical_variant_id = $1 AND mr.valid_to IS NULL
          ORDER BY mr.status, s.sort_order`,
        [id],
      ),
      query(
        `SELECT vss.*, s.key AS shop_key, s.name AS shop_name, s.health_status, s.brand_color
           FROM variant_shop_status vss
           JOIN shops s ON s.id = vss.shop_id
          WHERE vss.canonical_variant_id = $1
          ORDER BY s.sort_order`,
        [id],
      ),
      query(
        `SELECT pe.*, s.key AS shop_key, s.name AS shop_name
           FROM price_events pe
           JOIN source_listings sl ON sl.id = pe.listing_id
           JOIN shops s ON s.id = sl.shop_id
          WHERE pe.canonical_variant_id = $1
          ORDER BY pe.occurred_at DESC LIMIT 50`,
        [id],
      ),
    ]);

    return { variant, offers, listings, shopStatus, recentEvents: events };
  });

  // ── Artortenet (spec 23.4) ───────────────────────────────────────────────
  app.get('/products/:id/price-history', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(730).default(180) })
      .parse(req.query);

    const rows = await query(
      `SELECT o.observed_at, o.selected_comparable_price_huf AS price_huf,
              o.regular_price_huf, o.price_type, o.in_stock,
              s.id AS shop_id, s.key AS shop_key, s.name AS shop_name, s.brand_color
         FROM offer_observations o
         JOIN source_listings sl ON sl.id = o.listing_id
         JOIN shops s ON s.id = sl.shop_id
         JOIN match_relations mr ON mr.source_listing_id = sl.id
        WHERE mr.canonical_variant_id = $1
          AND mr.status = 'verified' AND mr.valid_to IS NULL
          AND o.comparable AND NOT o.quarantined
          AND o.observed_at > now() - ($2 || ' days')::interval
        ORDER BY o.observed_at`,
      [id, String(days)],
    );
    return { items: rows, days };
  });

  app.get('/products/:id/offers', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { items: await query('SELECT * FROM v_market_offers WHERE canonical_variant_id = $1 ORDER BY price_huf', [id]) };
  });

  app.get('/products/:id/listings', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return {
      items: await query(
        `SELECT sl.*, s.key AS shop_key, s.name AS shop_name, mr.status AS match_status
           FROM match_relations mr
           JOIN source_listings sl ON sl.id = mr.source_listing_id
           JOIN shops s ON s.id = sl.shop_id
          WHERE mr.canonical_variant_id = $1 AND mr.valid_to IS NULL`,
        [id],
      ),
    };
  });

  // ── Letrehozas / modositas ───────────────────────────────────────────────
  const createSchema = z.object({
    categoryKey: z.string(),
    familyName: z.string().min(2),
    displayName: z.string().min(2),
    productLine: z.string().optional(),
    producerName: z.string().optional(),
    brandName: z.string().optional(),
    vintageValue: z.number().int().min(1800).max(2100).nullable().optional(),
    vintageStatus: z.enum(['vintage', 'non_vintage', 'not_applicable', 'unknown']).default('unknown'),
    ageStatementYears: z.number().int().min(0).max(100).nullable().optional(),
    volumeMl: z.number().int().positive().nullable().optional(),
    packCount: z.number().int().positive().default(1),
    packagingType: z.enum(['unknown', 'standard', 'gift_box', 'wooden_case', 'carton', 'tube', 'set', 'tin']).default('unknown'),
    edition: z.string().nullable().optional(),
    puttony: z.number().int().min(3).max(6).nullable().optional(),
    dosageStyle: z.string().nullable().optional(),
    abvPercent: z.number().min(0).max(100).nullable().optional(),
    gtin: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    track: z.boolean().default(false),
  });

  app.post('/products', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const body = createSchema.parse(req.body);

    const category = await queryOne<{ id: string; identity_profile: unknown; comparison_policy: unknown }>(
      'SELECT id, identity_profile, comparison_policy FROM product_categories WHERE key = $1', [body.categoryKey],
    );
    if (!category) throw new AppError('UNKNOWN_CATEGORY', `Ismeretlen kategoria: ${body.categoryKey}`, 400);

    const result = await transaction(async (client) => {
      const producerId = body.producerName
        ? (await upsertNamed(client, 'producers', body.producerName)) : null;
      const brandId = body.brandName
        ? (await upsertNamed(client, 'brands', body.brandName)) : null;

      const family = await client.query<{ id: string }>(
        `INSERT INTO product_families
           (category_id, producer_id, brand_id, canonical_name, product_line, region, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7)
         RETURNING id`,
        [category.id, producerId, brandId, body.familyName, body.productLine ?? null, body.region ?? null, actor.id],
      );
      const familyId = family.rows[0]!.id;

      const identity = {
        categoryKey: body.categoryKey, producer: body.producerName ?? null, producerId,
        brand: body.brandName ?? null, brandId, expression: body.productLine ?? body.familyName,
        vintageValue: body.vintageValue ?? null, vintageStatus: body.vintageStatus,
        ageStatementYears: body.ageStatementYears ?? null, volumeMl: body.volumeMl ?? null,
        packCount: body.packCount, packagingType: body.packagingType,
        containerType: null, edition: body.edition ?? null, caskFinish: null,
        dosageStyle: body.dosageStyle ?? null, sweetness: null, puttony: body.puttony ?? null,
        abvPercent: body.abvPercent ?? null, colour: null, region: body.region ?? null,
        countryCode: null, grapeVarieties: [], gtin: body.gtin ?? null, sku: null,
        flavour: null, fruit: null, aging: null, subcategory: null,
        appellation: null, vineyard: null, organic: null,
      };

      const variant = await client.query<{ id: string }>(
        `INSERT INTO canonical_variants
           (product_family_id, canonical_display_name, vintage_value, vintage_status,
            age_statement_years, volume_ml, pack_count, packaging_type, edition,
            puttony, dosage_style, abv_percent, gtin, gtin_normalized,
            identity_profile_json, comparison_policy_json, identity_hash,
            status, origin, created_by, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active','manual',$18,$18, now())
         RETURNING id`,
        [
          familyId, body.displayName, body.vintageValue ?? null, body.vintageStatus,
          body.ageStatementYears ?? null, body.volumeMl ?? null, body.packCount,
          body.packagingType, body.edition ?? null, body.puttony ?? null,
          body.dosageStyle ?? null, body.abvPercent ?? null, body.gtin ?? null,
          body.gtin ? body.gtin.replace(/\D/g, '') : null,
          JSON.stringify(category.identity_profile), JSON.stringify(category.comparison_policy),
          identityHash({ identity: identity as never }),
          actor.id,
        ],
      );
      const variantId = variant.rows[0]!.id;

      if (body.track) {
        await client.query(
          `INSERT INTO tracked_products (canonical_variant_id, tracking_origin, approved_by, approved_at)
           VALUES ($1,'manual',$2, now())`,
          [variantId, actor.id],
        );
      }

      // Azonnal indul a kereses MINDEN aktiv webshopban (spec 5.1/7)
      await client.query(
        `INSERT INTO variant_shop_status (canonical_variant_id, shop_id, status, next_search_at)
         SELECT $1, id, 'unsearched', now() FROM shops WHERE active AND NOT policy_disabled
         ON CONFLICT DO NOTHING`,
        [variantId],
      );

      return { variantId, familyId };
    });

    await enqueue({
      redisUrl: config.REDIS_URL,
      queue: 'candidate-generation',
      name: 'search-all-shops',
      payload: { canonicalVariantId: result.variantId, trigger: 'created' },
      idempotencyKey: `search:${result.variantId}:created`,
      priority: JOB_PRIORITY['manual-search'],
      correlationId: req.correlationId,
    }).catch(() => undefined);

    await audit({
      actorUserId: actor.id, action: 'product.created', entityType: 'canonical_variant',
      entityId: result.variantId, summary: body.displayName,
      after: body, correlationId: req.correlationId,
    });

    return { id: result.variantId, productFamilyId: result.familyId, searchQueued: true };
  });

  app.patch('/products/:id', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = createSchema.partial().parse(req.body);

    const before = await queryOne('SELECT * FROM canonical_variants WHERE id = $1', [id]);
    if (!before) throw new AppError('NOT_FOUND', 'A termek nem talalhato.', 404);

    const updates: string[] = [];
    const params: unknown[] = [id];
    const map: Record<string, string> = {
      displayName: 'canonical_display_name', vintageValue: 'vintage_value',
      vintageStatus: 'vintage_status', ageStatementYears: 'age_statement_years',
      volumeMl: 'volume_ml', packCount: 'pack_count', packagingType: 'packaging_type',
      edition: 'edition', puttony: 'puttony', dosageStyle: 'dosage_style',
      abvPercent: 'abv_percent', gtin: 'gtin',
    };
    for (const [key, column] of Object.entries(map)) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined) {
        params.push(value);
        updates.push(`${column} = $${params.length}`);
      }
    }
    if (!updates.length) return { ok: true, changed: 0 };
    updates.push('version = version + 1');

    await execute(`UPDATE canonical_variants SET ${updates.join(', ')} WHERE id = $1`, params);

    // Identitasvaltozas -> ujraparositas minden erintett webshopra (spec 16.5)
    await execute(
      `UPDATE variant_shop_status SET status = 'unsearched', next_search_at = now()
        WHERE canonical_variant_id = $1`,
      [id],
    );
    await enqueue({
      redisUrl: config.REDIS_URL, queue: 'candidate-generation', name: 'search-all-shops',
      payload: { canonicalVariantId: id, trigger: 'canonical_edited' },
      idempotencyKey: `search:${id}:edit:${Date.now()}`,
      priority: JOB_PRIORITY['manual-search'], correlationId: req.correlationId,
    }).catch(() => undefined);

    await audit({
      actorUserId: actor.id, action: 'product.updated', entityType: 'canonical_variant',
      entityId: id, before, after: body, correlationId: req.correlationId,
      summary: 'Kanonikus identitas modositva - ujraparositas indul minden webshopra.',
    });
    return { ok: true, rematchQueued: true };
  });

  // ── Figyeloliste ─────────────────────────────────────────────────────────
  app.post('/products/:id/track', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      label: z.string().optional(),
      priority: z.number().int().min(1).max(1000).default(100),
    }).parse(req.body ?? {});

    await execute(
      `INSERT INTO tracked_products (canonical_variant_id, tracking_origin, tracking_label, priority, approved_by, approved_at, active)
       VALUES ($1,'manual',$2,$3,$4, now(), true)
       ON CONFLICT (canonical_variant_id) WHERE active
       DO UPDATE SET tracking_label = EXCLUDED.tracking_label, priority = EXCLUDED.priority`,
      [id, body.label ?? null, body.priority, actor.id],
    );
    await audit({
      actorUserId: actor.id, action: 'product.tracked', entityType: 'canonical_variant', entityId: id,
      correlationId: req.correlationId,
    });
    return { ok: true };
  });

  app.delete('/products/:id/track', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await execute(
      `UPDATE tracked_products SET active = false, suspension_reason = 'Kezi eltavolitas a figyelolistarol'
        WHERE canonical_variant_id = $1 AND active`,
      [id],
    );
    await audit({
      actorUserId: actor.id, action: 'product.untracked', entityType: 'canonical_variant', entityId: id,
      correlationId: req.correlationId,
    });
    return { ok: true };
  });

  // ── Muveletek ────────────────────────────────────────────────────────────
  app.post('/products/:id/search-now', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ shopId: z.string().uuid().optional() }).parse(req.body ?? {});

    await execute(
      `UPDATE variant_shop_status SET next_search_at = now()
        WHERE canonical_variant_id = $1 ${body.shopId ? 'AND shop_id = $2' : ''}`,
      body.shopId ? [id, body.shopId] : [id],
    );
    const job = await enqueue({
      redisUrl: config.REDIS_URL, queue: 'candidate-generation', name: 'search-all-shops',
      payload: { canonicalVariantId: id, shopId: body.shopId ?? null, trigger: 'manual' },
      idempotencyKey: `search:${id}:manual:${body.shopId ?? 'all'}`,
      priority: JOB_PRIORITY['manual-search'], correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'product.search_now', entityType: 'canonical_variant', entityId: id,
      metadata: { shopId: body.shopId }, correlationId: req.correlationId,
    });
    return { accepted: true, jobId: job.jobId, deduped: job.deduped, state: job.state, waiting: job.waiting };
  });

  app.post('/products/:id/approve', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await execute(
      `UPDATE canonical_variants SET status = 'active', approved_by = $2, approved_at = now()
        WHERE id = $1 AND status = 'proposed'`,
      [id, actor.id],
    );
    await audit({
      actorUserId: actor.id, action: 'product.approved', entityType: 'canonical_variant', entityId: id,
      correlationId: req.correlationId,
    });
    return { ok: true };
  });

  app.post('/products/:id/suspend', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    await execute(`UPDATE canonical_variants SET status = 'suspended' WHERE id = $1`, [id]);
    await audit({
      actorUserId: actor.id, action: 'product.suspended', entityType: 'canonical_variant', entityId: id,
      summary: body.reason, correlationId: req.correlationId,
    });
    return { ok: true };
  });

  // ── Merge / split: verziozott muvelet, nem egyszeru felulirás (spec 8.9) ─
  app.post('/products/:id/merge', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      targetVariantId: z.string().uuid(),
      reason: z.string().min(3),
    }).parse(req.body);
    if (id === body.targetVariantId) throw new AppError('INVALID_MERGE', 'Egy termek nem vonhato ossze onmagaval.', 400);

    await transaction(async (client) => {
      // A regi kapcsolatok lezarasa es ujranyitas a cel valtozatra
      await client.query(
        `UPDATE match_relations SET valid_to = now()
          WHERE canonical_variant_id = $1 AND valid_to IS NULL`,
        [id],
      );
      await client.query(
        `INSERT INTO match_relations
           (canonical_variant_id, source_listing_id, shop_id, status, decision_origin,
            verified_kind, locked_by_human, identity_hash_at_decision)
         SELECT $2, mr.source_listing_id, mr.shop_id, mr.status, 'human',
                mr.verified_kind, mr.locked_by_human, mr.identity_hash_at_decision
           FROM match_relations mr
          WHERE mr.canonical_variant_id = $1 AND mr.valid_to = (SELECT max(valid_to) FROM match_relations WHERE canonical_variant_id = $1)
         ON CONFLICT DO NOTHING`,
        [id, body.targetVariantId],
      );
      await client.query(
        `UPDATE canonical_variants SET status = 'merged', merged_into_id = $2 WHERE id = $1`,
        [id, body.targetVariantId],
      );
    });

    await audit({
      actorUserId: actor.id, action: 'product.merged', entityType: 'canonical_variant', entityId: id,
      summary: body.reason, after: { mergedInto: body.targetVariantId }, correlationId: req.correlationId,
    });
    return { ok: true, mergedInto: body.targetVariantId };
  });

  // ── Kategoriak es identitasprofilok ──────────────────────────────────────
  app.get('/categories', async () => {
    const items = await query(
      `SELECT id, key, name_hu, name_en, kind, identity_profile, comparison_policy,
              noise_terms, noise_terms_version, sort_order
         FROM product_categories WHERE active ORDER BY sort_order, name_hu`,
    );
    return { items };
  });

  app.get('/categories/:key/profile', async (req) => {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const row = await queryOne<{ identity_profile: never; comparison_policy: never }>(
      'SELECT identity_profile, comparison_policy FROM product_categories WHERE key = $1', [key],
    );
    if (!row) throw new AppError('NOT_FOUND', 'Ismeretlen kategoria.', 404);
    const resolved = resolveIdentityProfile({
      categoryProfile: row.identity_profile, categoryPolicy: row.comparison_policy,
    });
    return {
      profile: resolved.profile,
      policy: resolved.policy,
      requiredFields: resolved.requiredFields,
      comparableFields: resolved.comparableFields,
    };
  });

  void requireRole;
}

async function upsertNamed(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }> },
  table: 'producers' | 'brands',
  name: string,
): Promise<string> {
  const existing = await client.query(
    `SELECT id FROM ${table} WHERE name_norm = rv_search_norm($1) AND status <> 'merged' LIMIT 1`,
    [name],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await client.query(
    `INSERT INTO ${table} (canonical_name, status) VALUES ($1, 'active') RETURNING id`,
    [name],
  );
  return created.rows[0]!.id;
}
