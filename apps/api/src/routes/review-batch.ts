/**
 * Valtozat-kozpontu ellenorzes es kotegelt dontes.
 *
 * A `review_cases` PARONKENT keletkezik: egy valtozat hat boltban hat kulon
 * eset. Ez az adatmodellben helyes - egy dontes egy bolt egy listingjerol
 * szol -, a MUNKAVEGZESHEZ viszont hasznalhatatlan huszezer tetelnel. Aki
 * dont, annak ugyanazt a kanonikus terméket hatszor kellene ujra megertenie.
 *
 * Ezert a sema valtozatlan marad, es csak a NEZET csoportosit: egy kepernyo
 * = egy termek + minden nyitott boltja, egy mentes = tobb dontes.
 */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { REASON_CODE_HU } from '@radovin/contracts';
import { query, queryOne, transaction } from '@radovin/db';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import { requireAtLeast } from '../lib/auth.js';
import { audit, pageParams, paginated } from '../lib/context.js';
import { enqueue, JOB_PRIORITY } from '../lib/queues.js';
import { applyApprove, applyReject, loadOpenCase } from './review-actions.js';

export async function reviewBatchRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // ── Valtozatonkent csoportositott sor ────────────────────────────────────
  app.get('/review-cases/grouped', async (req) => {
    const q = z.object({
      caseType: z.string().optional(),
      shopId: z.string().uuid().optional(),
      category: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const where: string[] = [
      `rc.status IN ('open','in_progress')`,
      'rc.canonical_variant_id IS NOT NULL',
    ];
    const params: unknown[] = [];
    if (q.caseType) where.push(`rc.case_type = $${params.push(q.caseType)}`);
    if (q.shopId) where.push(`rc.shop_id = $${params.push(q.shopId)}`);
    if (q.category) where.push(`pc.key = $${params.push(q.category)}`);
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [items, countRow] = await Promise.all([
      query(
        `SELECT rc.canonical_variant_id,
                cv.canonical_display_name, cv.vintage_value, cv.volume_ml,
                pc.key AS category_key,
                pr.canonical_name AS producer_name,
                count(*)::int AS open_cases,
                min(rc.priority) AS priority,
                max(rc.confidence) AS confidence,
                bool_or(rc.case_type = 'ambiguous') AS has_ambiguous,
                array_agg(DISTINCT s.key) AS shop_keys,
                min(rc.created_at) AS oldest_at,
                min(rc.due_at) AS due_at,
                (SELECT count(*)::int FROM match_relations mr
                  WHERE mr.canonical_variant_id = rc.canonical_variant_id
                    AND mr.status = 'verified' AND mr.valid_to IS NULL) AS verified_shop_count,
                (SELECT sl2.image_url FROM match_relations mr2
                   JOIN source_listings sl2 ON sl2.id = mr2.source_listing_id
                  WHERE mr2.canonical_variant_id = rc.canonical_variant_id
                    AND mr2.status = 'verified' AND mr2.valid_to IS NULL
                    AND sl2.image_url IS NOT NULL
                  LIMIT 1) AS image_url
           FROM review_cases rc
           JOIN canonical_variants cv ON cv.id = rc.canonical_variant_id
           JOIN product_families pf ON pf.id = cv.product_family_id
           JOIN product_categories pc ON pc.id = pf.category_id
           LEFT JOIN producers pr ON pr.id = pf.producer_id
           LEFT JOIN shops s ON s.id = rc.shop_id
           ${whereSql}
          GROUP BY rc.canonical_variant_id, cv.canonical_display_name,
                   cv.vintage_value, cv.volume_ml, pc.key, pr.canonical_name
          -- A hozam szerint: eloszor a majdnem biztos esetek, azon belul
          -- ahol egyszerre tobb boltrol lehet donteni.
          ORDER BY min(rc.priority) ASC,
                   count(*) DESC,
                   max(rc.confidence) DESC NULLS LAST,
                   min(rc.created_at) ASC
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(
        `SELECT count(DISTINCT rc.canonical_variant_id)::int AS total
           FROM review_cases rc
           JOIN canonical_variants cv ON cv.id = rc.canonical_variant_id
           JOIN product_families pf ON pf.id = cv.product_family_id
           JOIN product_categories pc ON pc.id = pf.category_id
           ${whereSql}`,
        params,
      ),
    ]);

    return { ...paginated(items, countRow?.total ?? 0, p), reasonLabels: REASON_CODE_HU };
  });

  // ── Egy valtozat teljes anyaga: a kartyas kepernyo forrasa ──────────────
  app.get('/review-cases/variant/:variantId', async (req) => {
    requireAtLeast(req.user, 'viewer');
    const { variantId } = z.object({ variantId: z.string().uuid() }).parse(req.params);

    const canonical = await queryOne(
      `SELECT cv.id, cv.canonical_display_name, cv.vintage_value, cv.vintage_status,
              cv.volume_ml, cv.pack_count, cv.packaging_type, cv.edition, cv.puttony,
              cv.abv_percent, cv.gtin_normalized, cv.grape_signature, cv.status,
              pf.canonical_name AS family_name, pf.region, pf.colour, pf.grape_varieties,
              pc.key AS category_key, pc.name_hu AS category_name,
              pr.canonical_name AS producer_name, br.canonical_name AS brand_name,
              ws.canonical_name AS wine_style_name
         FROM canonical_variants cv
         JOIN product_families pf ON pf.id = cv.product_family_id
         JOIN product_categories pc ON pc.id = pf.category_id
         LEFT JOIN producers pr ON pr.id = pf.producer_id
         LEFT JOIN brands br ON br.id = pf.brand_id
         LEFT JOIN wine_styles ws ON ws.id = cv.wine_style_id
        WHERE cv.id = $1`,
      [variantId],
    );
    if (!canonical) throw new AppError('NOT_FOUND', 'A termekvaltozat nem talalhato.', 404);

    // A mar igazolt boltok adjak a viszonyitasi arat es a kepet - a
    // kanonikus valtozatnak nincs sajat keposzlopa a semaban.
    const verified = await query(
      `SELECT sl.id, sl.raw_name, sl.canonical_url, sl.image_url,
              s.key AS shop_key, s.name AS shop_name, s.brand_color,
              o.selected_comparable_price_huf AS price_huf, o.observed_at
         FROM match_relations mr
         JOIN source_listings sl ON sl.id = mr.source_listing_id
         JOIN shops s ON s.id = mr.shop_id
         LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
        WHERE mr.canonical_variant_id = $1
          AND mr.status = 'verified' AND mr.valid_to IS NULL
        ORDER BY o.selected_comparable_price_huf NULLS LAST`,
      [variantId],
    );

    const cases = await query(
      `SELECT rc.id, rc.case_type, rc.status, rc.priority, rc.reason_codes,
              rc.confidence, rc.row_version, rc.due_at, rc.candidates,
              rc.context->>'explanation' AS explanation,
              rc.context->'fieldResults' AS field_results,
              (rc.context->>'priceRatio')::numeric AS price_ratio,
              rc.source_listing_id,
              sl.raw_name, sl.canonical_url, sl.image_url, sl.expression,
              sl.vintage_value, sl.volume_ml, sl.pack_count, sl.packaging_type,
              sl.abv_percent, sl.extraction_quality, sl.colour,
              s.id AS shop_id, s.key AS shop_key, s.name AS shop_name, s.brand_color,
              o.selected_comparable_price_huf AS price_huf,
              o.availability_status, o.observed_at,
              g.names AS grape_names
         FROM review_cases rc
         LEFT JOIN source_listings sl ON sl.id = rc.source_listing_id
         LEFT JOIN shops s ON s.id = rc.shop_id
         LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
         LEFT JOIN LATERAL (
           SELECT array_agg(gv.canonical_name ORDER BY gv.canonical_name) AS names
             FROM source_listing_grapes slg
             JOIN grape_varieties gv ON gv.id = slg.grape_variety_id
            WHERE slg.source_listing_id = sl.id
         ) g ON true
        WHERE rc.canonical_variant_id = $1
          AND rc.status IN ('open','in_progress')
        ORDER BY o.selected_comparable_price_huf NULLS LAST`,
      [variantId],
    );

    return { canonical, verified, cases, reasonLabels: REASON_CODE_HU };
  });

  // ── Kotegelt dontes ──────────────────────────────────────────────────────
  //
  // Reszleges siker a szandekolt viselkedes: ha harom kartyabol egy elavult
  // (kozben mas dontott rola), a masik ketto lemegy, es a harmadikrol a
  // felulet konkret hibat kap. Az "egesz koteg elszall" valtozat itt rossz
  // lenne: az ember munkajat dobna el egy masik ember dontese miatt.
  app.post('/review-cases/bulk', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const body = z.object({
      decisions: z.array(z.object({
        caseId: z.string().uuid(),
        action: z.enum(['approve', 'reject']),
        rowVersion: z.number().int().optional(),
        sourceListingId: z.string().uuid().optional(),
        reasonCode: z.string().min(2).optional(),
        note: z.string().max(2000).optional(),
      })).min(1).max(50),
    }).parse(req.body);

    const results: Array<{
      caseId: string; ok: boolean; error?: string; message?: string; currentVersion?: number;
    }> = [];
    const approvedListings: string[] = [];

    for (const d of body.decisions) {
      try {
        if (d.action === 'reject' && !d.reasonCode) {
          throw new AppError('REASON_REQUIRED', 'Az elutasitashoz indok kell.', 400);
        }
        const rc = await loadOpenCase(d.caseId, d.rowVersion);
        const listingId = d.sourceListingId ?? rc.source_listing_id;
        if (!rc.canonical_variant_id || !listingId) {
          throw new AppError('INVALID_CASE', 'Az esethez nem tartozik kanonikus termek vagy listing.', 400);
        }
        const variantId = rc.canonical_variant_id;

        await transaction(async (client: PoolClient) => {
          if (d.action === 'approve') {
            await applyApprove(client, {
              caseId: d.caseId, canonicalVariantId: variantId, listingId,
              actorId: actor.id, note: d.note ?? null, confidence: rc.confidence ?? null,
            });
          } else {
            await applyReject(client, {
              caseId: d.caseId, canonicalVariantId: variantId, listingId,
              shopId: rc.shop_id, actorId: actor.id, note: d.note ?? null,
              confidence: rc.confidence ?? null, reasonCode: d.reasonCode!,
            });
          }
        });

        if (d.action === 'approve') approvedListings.push(listingId);
        results.push({ caseId: d.caseId, ok: true });
      } catch (err) {
        if (err instanceof AppError) {
          results.push({
            caseId: d.caseId, ok: false, error: err.code, message: err.message,
            currentVersion: (err.detail as { currentVersion?: number } | undefined)?.currentVersion,
          });
        } else {
          results.push({
            caseId: d.caseId, ok: false, error: 'INTERNAL',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Jovahagyas utan azonnali arfrissites (spec 18.1). Hiba eseten sem
    // buktatjuk el a mar meghozott donteseket.
    for (const listingId of approvedListings) {
      await enqueue({
        redisUrl: config.REDIS_URL, queue: 'known-listing-refresh', name: 'refresh-listing',
        payload: { sourceListingId: listingId, trigger: 'review_bulk_approved' },
        idempotencyKey: `refresh-listing:${listingId}:${Date.now()}`,
        priority: JOB_PRIORITY['known-listing-refresh'], correlationId: req.correlationId,
      }).catch(() => undefined);
    }

    const okCount = results.filter((r) => r.ok).length;
    await audit({
      actorUserId: actor.id, action: 'review.bulk_decided', entityType: 'review_case', entityId: null,
      summary: `${okCount}/${results.length} dontes vegrehajtva.`,
      metadata: { results }, correlationId: req.correlationId,
    });

    return { ok: okCount === results.length, applied: okCount, results };
  });

  // ── A klaszterezesi hatralek kezi inditasa ──────────────────────────────
  app.post('/matching/sweep', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const body = z.object({
      limit: z.number().int().min(10).max(5000).optional(),
      shopKey: z.string().optional(),
    }).parse(req.body ?? {});

    const pending = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM source_listings sl JOIN shops s ON s.id = sl.shop_id
        WHERE sl.listing_status = 'active' AND sl.cluster_status = 'unclustered'
          AND s.active AND NOT s.policy_disabled`,
    );

    const job = await enqueue({
      redisUrl: config.REDIS_URL,
      queue: 'candidate-generation', name: 'cluster-sweep',
      payload: {
        limit: body.limit ?? 300,
        ...(body.shopKey ? { shopKey: body.shopKey } : {}),
      },
      idempotencyKey: 'cluster:sweep',
      correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'matching.sweep_triggered',
      entityType: 'source_listing', entityId: null,
      summary: `Klaszterezesi sopres inditva (hatralek: ${pending?.count ?? 0}).`,
      correlationId: req.correlationId,
    });

    return {
      accepted: true, jobId: job.jobId, deduped: job.deduped,
      state: job.state, backlog: pending?.count ?? 0,
    };
  });
}
