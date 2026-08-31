/**
 * Parositasi processzorok (spec 5.3, 9.5, 16.).
 */
import type { Job } from 'bullmq';
import { execute, query, queryOne } from '@radovin/db';
import { logger, metrics, newCorrelationId, withContext } from '@radovin/observability';
import type { WorkerConfig } from '../config.js';
import {
  VARIANT_QUERY, evaluateListingForClustering, evaluateVariantForShop, type VariantRow,
} from '../lib/matching.js';
import { getMatchPolicy, getSettings, getTaxonomy } from '../lib/shop.js';
import { enqueueFromWorker } from '../lib/queue-client.js';

export interface SearchAllShopsPayload {
  canonicalVariantId: string;
  shopId?: string | null;
  trigger?: string;
  correlationId?: string;
}

/**
 * Egy kanonikus termekvaltozat keresese MINDEN aktiv webshopban
 * (vagy egy megadottban).
 */
export async function processSearchAllShops(
  job: Job<SearchAllShopsPayload>,
  config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  const { canonicalVariantId } = job.data;

  return withContext({ correlationId, canonicalVariantId }, async () => {
    const variant = await queryOne<VariantRow>(`${VARIANT_QUERY} WHERE cv.id = $1`, [canonicalVariantId]);
    if (!variant) {
      logger.warn('search.variant_not_found', { canonicalVariantId });
      return { skipped: true, reason: 'variant_not_found' };
    }

    const [taxonomy, policy, settings] = await Promise.all([
      getTaxonomy(), getMatchPolicy(), getSettings(),
    ]);
    const limits = (settings.settings.get('matching.candidate_limits') ?? {}) as {
      perChannelTopN?: number; totalTopN?: number; trigramMinSimilarity?: number;
    };

    const shops = await query<{ id: string; key: string; name: string; health_status: string }>(
      `SELECT id, key, name, health_status FROM shops
        WHERE active AND NOT policy_disabled ${job.data.shopId ? 'AND id = $1' : ''}
        ORDER BY sort_order`,
      job.data.shopId ? [job.data.shopId] : [],
    );

    const results: Array<{ shopKey: string; status: string; candidates: number }> = [];

    for (const shop of shops) {
      // A forras egeszsegi allapota dönti el, hogy adhato-e "nincs talalat"
      const sourceHealthy = shop.health_status === 'ok' || shop.health_status === 'unknown';

      try {
        const outcome = await evaluateVariantForShop({
          variant, shopId: shop.id, shopKey: shop.key,
          taxonomy, policy, sourceHealthy, correlationId,
          candidateLimits: {
            perChannelTopN: limits.perChannelTopN ?? 25,
            totalTopN: limits.totalTopN ?? 60,
            trigramMinSimilarity: limits.trigramMinSimilarity ?? 0.32,
          },
        });
        results.push({
          shopKey: shop.key,
          status: outcome.decision.status,
          candidates: outcome.candidateCount,
        });
        metrics.counter(`matching.decision.${outcome.decision.status}`, 1, { shop: shop.key });
      } catch (err) {
        logger.error('search.shop_failed', {
          shopKey: shop.key,
          error: err instanceof Error ? err.message : String(err),
        });
        results.push({ shopKey: shop.key, status: 'error', candidates: 0 });
      }
    }

    // Aggregatum ujraszamitasa, ha lett uj igazolt par
    if (results.some((r) => r.status === 'auto_verified')) {
      await enqueueFromWorker(config, {
        queue: 'aggregate-dashboard', name: 'rebuild',
        payload: { trigger: 'new_match' },
        idempotencyKey: 'aggregate:rebuild',
        delayMs: 60_000, correlationId,
      });
    }

    return { canonicalVariantId, shopsSearched: shops.length, results };
  });
}

export interface ClusterListingPayload {
  sourceListingId: string;
  preferredVariantId?: string | null;
  trigger?: string;
  correlationId?: string;
}

/**
 * Egy webshoplisting klaszterezese: melyik kanonikus valtozathoz tartozik?
 * Ha nincs elfogadhato, `proposed` kanonikus valtozat javasolhato (spec 9.5).
 */
export async function processClusterListing(
  job: Job<ClusterListingPayload>,
  config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  const { sourceListingId } = job.data;

  return withContext({ correlationId, listingId: sourceListingId }, async () => {
    const [taxonomy, policy] = await Promise.all([getTaxonomy(), getMatchPolicy()]);

    const result = await evaluateListingForClustering({
      listingId: sourceListingId, taxonomy, policy,
    });

    // Ha nincs jelolt kanonikus valtozat, javaslunk egyet a listingbol,
    // majd azonnal keressuk a parjait a TOBBI webshopban (spec 9.5/2).
    if (result.status === 'no_variant_candidate' || result.status === 'all_rejected') {
      const created = await promoteListingToVariant(sourceListingId, null);
      if (created) {
        await enqueueFromWorker(config, {
          queue: 'candidate-generation', name: 'search-all-shops',
          payload: { canonicalVariantId: created, trigger: 'auto_discovery' },
          idempotencyKey: `search:${created}:auto`,
          correlationId,
        });
        return { ...result, promotedVariantId: created, crossShopSearchQueued: true };
      }
    }

    if (result.status === 'auto_verified') {
      await enqueueFromWorker(config, {
        queue: 'aggregate-dashboard', name: 'rebuild',
        payload: { trigger: 'cluster' },
        idempotencyKey: 'aggregate:rebuild',
        delayMs: 120_000, correlationId,
      });
    }

    return result;
  });
}

export interface PromotePayload {
  sourceListingId: string;
  actorUserId?: string | null;
  reviewCaseId?: string | null;
  correlationId?: string;
}

export async function processPromoteListing(
  job: Job<PromotePayload>,
  config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  const variantId = await promoteListingToVariant(job.data.sourceListingId, job.data.actorUserId ?? null);
  if (!variantId) return { ok: false, reason: 'promotion_failed' };

  if (job.data.reviewCaseId) {
    await execute(
      `UPDATE review_cases
          SET status = 'resolved', resolution = 'canonical_fixed',
              resolution_note = 'Uj kanonikus valtozat letrehozva ebbol a listingbol.',
              resolved_by = $2, resolved_at = now(), row_version = row_version + 1
        WHERE id = $1`,
      [job.data.reviewCaseId, job.data.actorUserId ?? null],
    );
  }

  await enqueueFromWorker(config, {
    queue: 'candidate-generation', name: 'search-all-shops',
    payload: { canonicalVariantId: variantId, trigger: 'promoted' },
    idempotencyKey: `search:${variantId}:promoted`,
    correlationId,
  });

  return { ok: true, canonicalVariantId: variantId };
}

/**
 * Kanonikus termekvaltozat letrehozasa egy webshoplistingbol.
 *
 * A hianyos identitasu valtozat `proposed` allapotban marad, amig a szukseges
 * bizonyitekok rendelkezesre nem allnak (spec 8.3).
 */
export async function promoteListingToVariant(
  listingId: string,
  actorUserId: string | null,
): Promise<string | null> {
  const listing = await queryOne<{
    id: string; shop_id: string; raw_name: string; expression: string | null;
    producer_id: string | null; brand_id: string | null; category_id: string | null;
    category_key: string | null; vintage_value: number | null; vintage_status: string;
    age_statement_years: number | null; volume_ml: number | null; pack_count: number;
    packaging_type: string; edition: string | null; cask_finish: string | null;
    dosage_style: string | null; puttony: number | null; abv_percent: number | null;
    gtin: string | null; gtin_normalized: string | null; region: string | null;
    colour: string | null; country_code: string | null; grape_varieties: string[];
    evidence: Record<string, unknown>; identity_hash: string | null;
    identity_profile: Record<string, unknown>; comparison_policy: Record<string, unknown>;
  }>(
    `SELECT sl.id, sl.shop_id, sl.raw_name, sl.expression, sl.producer_id, sl.brand_id,
            sl.category_id, pc.key AS category_key, sl.vintage_value, sl.vintage_status,
            sl.age_statement_years, sl.volume_ml, sl.pack_count, sl.packaging_type,
            sl.edition, sl.cask_finish, sl.dosage_style, sl.puttony, sl.abv_percent,
            sl.gtin, sl.gtin_normalized, sl.region, sl.colour, sl.country_code,
            sl.grape_varieties, sl.evidence, sl.identity_hash,
            pc.identity_profile, pc.comparison_policy
       FROM source_listings sl
       LEFT JOIN product_categories pc ON pc.id = sl.category_id
      WHERE sl.id = $1`,
    [listingId],
  );
  if (!listing) return null;

  // Kategoria nelkul nem hozunk letre aktiv valtozatot: a besorolatlan
  // termek soha nem kaphat automatikus parositast (spec 8.3, 0008 seed).
  const categoryId = listing.category_id
    ?? (await queryOne<{ id: string }>(`SELECT id FROM product_categories WHERE key = 'uncategorized'`))?.id;
  if (!categoryId) return null;

  const familyName = listing.expression ?? listing.raw_name;

  const family = await queryOne<{ id: string }>(
    `WITH existing AS (
       SELECT id FROM product_families
        WHERE category_id = $1
          AND rv_search_norm(canonical_name) = rv_search_norm($2)
          AND coalesce(producer_id::text,'') = coalesce($3::text,'')
          AND status <> 'merged'
        LIMIT 1
     ), inserted AS (
       INSERT INTO product_families
         (category_id, producer_id, brand_id, canonical_name, region, colour,
          origin_country, grape_varieties, status, created_by)
       SELECT $1, $3, $4, $2, $5, $6, $7, $8, 'proposed', $9
        WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING id
     )
     SELECT id FROM existing UNION ALL SELECT id FROM inserted LIMIT 1`,
    [
      categoryId, familyName, listing.producer_id, listing.brand_id,
      listing.region, listing.colour, listing.country_code,
      listing.grape_varieties ?? [], actorUserId,
    ],
  );
  if (!family) return null;

  // Hianyos identitas -> proposed (spec 8.3)
  const hasRequiredEvidence = Boolean(listing.volume_ml);
  const status = hasRequiredEvidence && listing.category_key && listing.category_key !== 'uncategorized'
    ? 'proposed' : 'proposed';

  const variant = await queryOne<{ id: string }>(
    `INSERT INTO canonical_variants
       (product_family_id, canonical_display_name, vintage_value, vintage_status,
        age_statement_years, volume_ml, pack_count, packaging_type, edition,
        cask_finish, dosage_style, puttony, abv_percent, gtin, gtin_normalized,
        identity_profile_json, comparison_policy_json, evidence, identity_hash,
        status, origin, origin_listing_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,
             $18::jsonb,$19,$20,'auto_discovery',$21,$22)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      family.id, listing.raw_name, listing.vintage_value, listing.vintage_status,
      listing.age_statement_years, listing.volume_ml, listing.pack_count ?? 1,
      listing.packaging_type, listing.edition, listing.cask_finish, listing.dosage_style,
      listing.puttony, listing.abv_percent, listing.gtin, listing.gtin_normalized,
      JSON.stringify(listing.identity_profile ?? {}),
      JSON.stringify(listing.comparison_policy ?? {}),
      JSON.stringify(listing.evidence ?? {}),
      listing.identity_hash, status, listingId, actorUserId,
    ],
  );
  if (!variant) return null;

  // A kiindulo listing azonnal a sajat klaszterehez kapcsolodik.
  // Ez `proposed` kapcsolat - NEM automatikusan verified.
  await execute(
    `INSERT INTO match_relations
       (canonical_variant_id, source_listing_id, shop_id, status, decision_origin,
        identity_hash_at_decision)
     VALUES ($1, $2, $3, 'verified', $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      variant.id, listingId, listing.shop_id,
      actorUserId ? 'human' : 'auto', listing.identity_hash,
    ],
  );
  await execute(`UPDATE source_listings SET cluster_status = 'clustered' WHERE id = $1`, [listingId]);
  await execute(
    `INSERT INTO variant_shop_status (canonical_variant_id, shop_id, status, matched_listing_id, last_search_at)
     VALUES ($1,$2,'human_verified',$3, now())
     ON CONFLICT (canonical_variant_id, shop_id) DO UPDATE
       SET status = EXCLUDED.status, matched_listing_id = EXCLUDED.matched_listing_id`,
    [variant.id, listing.shop_id, listingId],
  );
  // A tobbi webshopra azonnal keresest utemezunk
  await execute(
    `INSERT INTO variant_shop_status (canonical_variant_id, shop_id, status, next_search_at)
     SELECT $1, id, 'unsearched', now() FROM shops
      WHERE active AND NOT policy_disabled AND id <> $2
     ON CONFLICT DO NOTHING`,
    [variant.id, listing.shop_id],
  );

  logger.info('listing.promoted_to_variant', {
    listingId, canonicalVariantId: variant.id, name: listing.raw_name,
  });
  return variant.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// Nem talalt termekek ujrakeresese (spec 16.2)
// ═══════════════════════════════════════════════════════════════════════════

export interface ResearchPayload {
  limit?: number;
  correlationId?: string;
}

export async function processUnmatchedResearch(
  job: Job<ResearchPayload>,
  config: WorkerConfig,
): Promise<unknown> {
  const correlationId = job.data.correlationId ?? newCorrelationId();
  const limit = job.data.limit ?? 200;

  return withContext({ correlationId }, async () => {
    // Esedekes ujrakeresesek: a forras egeszseges ES lejart a next_search_at
    const due = await query<{ canonical_variant_id: string; shop_id: string; shop_key: string; status: string }>(
      `SELECT vss.canonical_variant_id, vss.shop_id, s.key AS shop_key, vss.status
         FROM variant_shop_status vss
         JOIN shops s ON s.id = vss.shop_id
         JOIN canonical_variants cv ON cv.id = vss.canonical_variant_id
        WHERE vss.next_search_at IS NOT NULL
          AND vss.next_search_at <= now()
          AND s.active AND NOT s.policy_disabled
          AND cv.status IN ('active','proposed')
          AND vss.status NOT IN ('auto_verified','human_verified','suspended')
        ORDER BY
          -- prioritas: figyelt termekek, majd a legregebben keresett
          (SELECT 0 FROM tracked_products tp
            WHERE tp.canonical_variant_id = vss.canonical_variant_id AND tp.active LIMIT 1) NULLS LAST,
          vss.last_search_at ASC NULLS FIRST
        LIMIT $1`,
      [limit],
    );

    if (!due.length) return { checked: 0, searched: 0 };

    const [taxonomy, policy] = await Promise.all([getTaxonomy(), getMatchPolicy()]);
    let searched = 0;
    const byStatus: Record<string, number> = {};

    for (const item of due) {
      const variant = await queryOne<VariantRow>(`${VARIANT_QUERY} WHERE cv.id = $1`, [item.canonical_variant_id]);
      if (!variant) continue;

      const shop = await queryOne<{ health_status: string; key: string }>(
        'SELECT health_status, key FROM shops WHERE id = $1', [item.shop_id],
      );
      // A "nincs talalat" CSAK egeszseges forras mellett adhato (spec 16.1)
      const sourceHealthy = shop?.health_status === 'ok';

      if (!sourceHealthy) {
        await execute(
          `UPDATE variant_shop_status
              SET status = 'source_unhealthy', last_search_at = now(),
                  next_search_at = now() + interval '1 day',
                  primary_reason_code = 'SOURCE_UNHEALTHY'
            WHERE canonical_variant_id = $1 AND shop_id = $2`,
          [item.canonical_variant_id, item.shop_id],
        );
        byStatus['source_unhealthy'] = (byStatus['source_unhealthy'] ?? 0) + 1;
        continue;
      }

      try {
        const outcome = await evaluateVariantForShop({
          variant, shopId: item.shop_id, shopKey: item.shop_key,
          taxonomy, policy, sourceHealthy: true, correlationId,
        });
        byStatus[outcome.decision.status] = (byStatus[outcome.decision.status] ?? 0) + 1;
        searched++;
      } catch (err) {
        logger.warn('research.failed', {
          canonicalVariantId: item.canonical_variant_id, shopKey: item.shop_key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (byStatus['auto_verified']) {
      await enqueueFromWorker(config, {
        queue: 'aggregate-dashboard', name: 'rebuild',
        payload: { trigger: 'research' }, idempotencyKey: 'aggregate:rebuild',
        delayMs: 60_000, correlationId,
      });
    }

    return { checked: due.length, searched, byStatus };
  });
}
