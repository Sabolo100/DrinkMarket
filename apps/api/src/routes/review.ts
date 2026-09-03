/**
 * Review queue - a parositasi hibak megelozesenek fo felulete (spec 21.4, 24.).
 *
 * Minden modosito keres tartalmaz dontesi megjegyzest, rekordverziot es
 * idempotency key-t. A kezi dontest automatika nem irhatja felul (spec 17.4).
 */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { REASON_CODE_HU } from '@radovin/contracts';
import { execute, query, queryOne, transaction } from '@radovin/db';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import { requireAtLeast } from '../lib/auth.js';
import {
  assertRowVersion, audit, pageParams, paginated, recallIdempotent, rememberIdempotent,
} from '../lib/context.js';
import { enqueue, JOB_PRIORITY } from '../lib/queues.js';
import {
  applyApprove, applyReject, closeCase, loadOpenCase, requestPublicationRebuild,
} from './review-actions.js';

const decisionBody = z.object({
  note: z.string().max(2000).optional(),
  rowVersion: z.number().int().optional(),
});

export async function reviewRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  /** A publikacio-ujraepites sorbaallitasa ennek a route-nak a configjaval. */
  const enqueueRebuild = (opts: {
    queue: 'aggregate-dashboard'; name: string; payload: Record<string, unknown>;
    idempotencyKey: string; delayMs?: number; correlationId?: string;
  }) => enqueue({ redisUrl: config.REDIS_URL, ...opts });

  // ── Lista (spec 24.1) ────────────────────────────────────────────────────
  app.get('/review-cases', async (req) => {
    const q = z.object({
      status: z.string().optional(),
      caseType: z.string().optional(),
      shopId: z.string().uuid().optional(),
      category: z.string().optional(),
      reasonCode: z.string().optional(),
      assignee: z.string().uuid().optional(),
      minConfidence: z.coerce.number().optional(),
      maxConfidence: z.coerce.number().optional(),
      overdue: z.enum(['true', 'false']).optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const where: string[] = [];
    const params: unknown[] = [];
    where.push(q.status ? `rc.status = $${params.push(q.status)}` : `rc.status IN ('open','in_progress')`);
    if (q.caseType) where.push(`rc.case_type = $${params.push(q.caseType)}`);
    if (q.shopId) where.push(`rc.shop_id = $${params.push(q.shopId)}`);
    if (q.reasonCode) where.push(`$${params.push(q.reasonCode)} = ANY(rc.reason_codes)`);
    if (q.assignee) where.push(`rc.assignee_user_id = $${params.push(q.assignee)}`);
    if (q.category) where.push(`pc.key = $${params.push(q.category)}`);
    if (q.minConfidence !== undefined) where.push(`rc.confidence >= $${params.push(q.minConfidence)}`);
    if (q.maxConfidence !== undefined) where.push(`rc.confidence <= $${params.push(q.maxConfidence)}`);
    if (q.overdue === 'true') where.push('rc.due_at < now()');

    const whereSql = `WHERE ${where.join(' AND ')}`;

    // Sorbarendezesi prioritas (spec 24.1):
    // 1. drift, 2. sok webshopot erinto termek, 3. magas confidence,
    // 4. tobb hasonlo varians, 5. regota megoldatlan
    const [items, countRow] = await Promise.all([
      query(
        `SELECT rc.id, rc.case_type, rc.status, rc.priority, rc.title, rc.reason_codes,
                rc.confidence, rc.created_at, rc.due_at, rc.deferred_until, rc.row_version,
                rc.canonical_variant_id, rc.source_listing_id, rc.shop_id,
                jsonb_array_length(coalesce(rc.candidates, '[]'::jsonb)) AS candidate_count,
                cv.canonical_display_name, cv.vintage_value, cv.volume_ml,
                sl.raw_name AS listing_name, sl.canonical_url AS listing_url, sl.image_url,
                s.key AS shop_key, s.name AS shop_name, s.brand_color,
                pc.key AS category_key,
                u.display_name AS assignee_name,
                (SELECT count(*)::int FROM match_relations mr
                  WHERE mr.canonical_variant_id = rc.canonical_variant_id
                    AND mr.status = 'verified' AND mr.valid_to IS NULL) AS verified_shop_count
           FROM review_cases rc
           LEFT JOIN canonical_variants cv ON cv.id = rc.canonical_variant_id
           LEFT JOIN product_families pf ON pf.id = cv.product_family_id
           LEFT JOIN product_categories pc ON pc.id = pf.category_id
           LEFT JOIN source_listings sl ON sl.id = rc.source_listing_id
           LEFT JOIN shops s ON s.id = rc.shop_id
           LEFT JOIN users u ON u.id = rc.assignee_user_id
           ${whereSql}
          ORDER BY
            (rc.case_type = 'mapping_drift') DESC,
            (rc.due_at IS NOT NULL AND rc.due_at < now()) DESC,
            rc.priority ASC,
            (SELECT count(*) FROM match_relations mr
              WHERE mr.canonical_variant_id = rc.canonical_variant_id
                AND mr.status = 'verified' AND mr.valid_to IS NULL) DESC,
            rc.confidence DESC NULLS LAST,
            rc.created_at ASC
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(
        `SELECT count(*)::int AS total
           FROM review_cases rc
           LEFT JOIN canonical_variants cv ON cv.id = rc.canonical_variant_id
           LEFT JOIN product_families pf ON pf.id = cv.product_family_id
           LEFT JOIN product_categories pc ON pc.id = pf.category_id
           ${whereSql}`,
        params,
      ),
    ]);

    const summary = await query<{ case_type: string; status: string; count: number }>(
      `SELECT case_type, status, count(*)::int AS count
         FROM review_cases WHERE status IN ('open','in_progress','deferred')
        GROUP BY case_type, status`,
    );

    return { ...paginated(items, countRow?.total ?? 0, p), summary, reasonLabels: REASON_CODE_HU };
  });

  // ── Reszletes nezet (spec 24.2) ─────────────────────────────────────────
  app.get('/review-cases/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rc = await queryOne<{
      canonical_variant_id: string | null; source_listing_id: string | null;
      match_decision_id: string | null; candidates: unknown;
    } & Record<string, unknown>>(
      `SELECT rc.*, s.key AS shop_key, s.name AS shop_name, s.brand_color, s.health_status,
              u.display_name AS assignee_name
         FROM review_cases rc
         LEFT JOIN shops s ON s.id = rc.shop_id
         LEFT JOIN users u ON u.id = rc.assignee_user_id
        WHERE rc.id = $1`,
      [id],
    );
    if (!rc) throw new AppError('NOT_FOUND', 'A felulvizsgalati eset nem talalhato.', 404);

    const [canonical, verifiedListings, candidateListing, decision, events] = await Promise.all([
      rc.canonical_variant_id
        ? queryOne(
          `SELECT cv.*, pf.canonical_name AS family_name, pf.product_line, pf.region,
                  pf.grape_varieties, pf.colour,
                  pc.key AS category_key, pc.name_hu AS category_name,
                  pc.identity_profile AS category_identity_profile,
                  pc.comparison_policy AS category_comparison_policy,
                  br.canonical_name AS brand_name, pr.canonical_name AS producer_name
             FROM canonical_variants cv
             JOIN product_families pf ON pf.id = cv.product_family_id
             JOIN product_categories pc ON pc.id = pf.category_id
             LEFT JOIN brands br ON br.id = pf.brand_id
             LEFT JOIN producers pr ON pr.id = pf.producer_id
            WHERE cv.id = $1`,
          [rc.canonical_variant_id],
        )
        : Promise.resolve(null),
      rc.canonical_variant_id
        ? query(
          `SELECT sl.id, sl.raw_name, sl.canonical_url, sl.image_url, sl.expression,
                  sl.vintage_value, sl.volume_ml, sl.pack_count, sl.packaging_type,
                  sl.extraction_quality, sl.evidence,
                  s.key AS shop_key, s.name AS shop_name, s.brand_color,
                  o.selected_comparable_price_huf AS price_huf, o.observed_at,
                  mr.status, mr.decision_origin
             FROM match_relations mr
             JOIN source_listings sl ON sl.id = mr.source_listing_id
             JOIN shops s ON s.id = mr.shop_id
             LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
            WHERE mr.canonical_variant_id = $1 AND mr.status = 'verified' AND mr.valid_to IS NULL`,
          [rc.canonical_variant_id],
        )
        : Promise.resolve([]),
      rc.source_listing_id
        ? queryOne(
          `SELECT sl.*, s.key AS shop_key, s.name AS shop_name, s.brand_color,
                  o.selected_comparable_price_huf AS price_huf, o.regular_price_huf,
                  o.price_type, o.comparable, o.not_comparable_reason, o.observed_at,
                  o.in_stock, o.availability_status
             FROM source_listings sl
             JOIN shops s ON s.id = sl.shop_id
             LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
            WHERE sl.id = $1`,
          [rc.source_listing_id],
        )
        : Promise.resolve(null),
      rc.match_decision_id
        ? queryOne('SELECT * FROM match_decisions WHERE id = $1', [rc.match_decision_id])
        : Promise.resolve(null),
      query(
        `SELECT e.*, u.display_name AS actor_name
           FROM review_case_events e LEFT JOIN users u ON u.id = e.actor_user_id
          WHERE e.review_case_id = $1 ORDER BY e.occurred_at DESC`,
        [id],
      ),
    ]);

    // A jeloltek reszletei
    const candidateIds = Array.isArray(rc.candidates)
      ? (rc.candidates as Array<{ listingId?: string }>).map((c) => c.listingId).filter(Boolean) as string[]
      : [];
    const candidateDetails = candidateIds.length
      ? await query(
        `SELECT sl.id, sl.raw_name, sl.canonical_url, sl.image_url, sl.expression,
                sl.vintage_value, sl.volume_ml, sl.pack_count, sl.packaging_type,
                sl.abv_percent, sl.gtin, sl.extraction_quality, sl.evidence,
                s.key AS shop_key, s.name AS shop_name, s.brand_color,
                o.selected_comparable_price_huf AS price_huf, o.observed_at, o.in_stock
           FROM source_listings sl
           JOIN shops s ON s.id = sl.shop_id
           LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
          WHERE sl.id = ANY($1::uuid[])`,
        [candidateIds],
      )
      : [];

    return {
      reviewCase: rc,
      canonical,
      verifiedListings,
      candidateListing,
      decision,
      candidateDetails,
      events,
      reasonLabels: REASON_CODE_HU,
    };
  });

  // ── Muveletek (spec 24.3) ───────────────────────────────────────────────

  app.post('/review-cases/:id/approve', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = decisionBody.extend({ sourceListingId: z.string().uuid().optional() }).parse(req.body ?? {});
    const idem = req.headers['x-idempotency-key'] as string | undefined;
    const cached = recallIdempotent(idem ? `approve:${id}:${idem}` : undefined);
    if (cached) return cached;

    const rc = await loadOpenCase(id, body.rowVersion);
    const listingId = body.sourceListingId ?? rc.source_listing_id;
    if (!rc.canonical_variant_id || !listingId) {
      throw new AppError('INVALID_CASE', 'Az esethez nem tartozik kanonikus termek vagy listing.', 400);
    }

    const variantId = rc.canonical_variant_id;
    await transaction(async (client) => {
      await applyApprove(client, {
        caseId: id, canonicalVariantId: variantId, listingId,
        actorId: actor.id, note: body.note ?? null, confidence: rc.confidence ?? null,
      });
    });

    // Jovahagyas utan azonnali arfrissites (spec 18.1)
    await enqueue({
      redisUrl: config.REDIS_URL, queue: 'known-listing-refresh', name: 'refresh-listing',
      payload: { sourceListingId: listingId, trigger: 'review_approved' },
      idempotencyKey: `refresh-listing:${listingId}:${Date.now()}`,
      priority: JOB_PRIORITY['known-listing-refresh'], correlationId: req.correlationId,
    }).catch(() => undefined);

    // Az ar-osszehasonlitas a publikacios tablabol olvas; az ujraepites
    // nelkul a dontes csak a scheduler kovetkezo koreben (orankent) latszana.
    await requestPublicationRebuild(enqueueRebuild, 'review_approved', req.correlationId);

    await audit({
      actorUserId: actor.id, action: 'review.approved', entityType: 'review_case', entityId: id,
      summary: body.note ?? 'Par jovahagyva.',
      metadata: { canonicalVariantId: rc.canonical_variant_id, sourceListingId: listingId },
      correlationId: req.correlationId,
    });

    const result = { ok: true, canonicalVariantId: rc.canonical_variant_id, sourceListingId: listingId };
    if (idem) rememberIdempotent(`approve:${id}:${idem}`, result);
    return result;
  });

  app.post('/review-cases/:id/reject', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = decisionBody.extend({
      reasonCode: z.string().min(2, 'A reason code kotelezo.'),
      sourceListingId: z.string().uuid().optional(),
    }).parse(req.body);

    const rc = await loadOpenCase(id, body.rowVersion);
    const listingId = body.sourceListingId ?? rc.source_listing_id;
    if (!rc.canonical_variant_id || !listingId) {
      throw new AppError('INVALID_CASE', 'Az esethez nem tartozik kanonikus termek vagy listing.', 400);
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE match_relations SET status = 'rejected', valid_to = now()
          WHERE canonical_variant_id = $1 AND source_listing_id = $2 AND valid_to IS NULL`,
        [rc.canonical_variant_id, listingId],
      );
      // Negativ memoria: azonos fingerprint mellett nem ajanljuk fel ujra (spec 14.3)
      await client.query(
        `INSERT INTO rejected_candidates
           (canonical_variant_id, source_listing_id, shop_id, rejected_by, reviewer_user_id,
            reason_code, reason_note, listing_identity_hash, variant_identity_hash, score_at_rejection)
         SELECT $1, $2, sl.shop_id, 'human', $3, $4, $5,
                coalesce(sl.identity_hash, ''), coalesce(cv.identity_hash, ''), $6
           FROM source_listings sl, canonical_variants cv
          WHERE sl.id = $2 AND cv.id = $1
         ON CONFLICT DO NOTHING`,
        [rc.canonical_variant_id, listingId, actor.id, body.reasonCode, body.note ?? null, rc.confidence ?? null],
      );
      // A valtozat-bolt allapot frissitese. Enelkul a sor NEM fogy: az
      // `unmatched-research` a `next_search_at` szerint ujra elovenne
      // ugyanezt a part, es az ember ujra dontene rola.
      //
      // A `rejected` allapot 30 napra tolja a kovetkezo keresest
      // (`nextSearchFor`), de nem zarja le orokre: egy uj listing vagy egy
      // javitott kinyeres kesobb hozhat jobb jeloltet.
      if (rc.shop_id) {
        await client.query(
          `INSERT INTO variant_shop_status
             (canonical_variant_id, shop_id, status, primary_reason_code,
              last_search_at, next_search_at, consecutive_no_match)
           VALUES ($1, $2, 'rejected', $3, now(), now() + interval '30 days', 0)
           ON CONFLICT (canonical_variant_id, shop_id) DO UPDATE SET
             status = 'rejected',
             primary_reason_code = EXCLUDED.primary_reason_code,
             matched_listing_id = NULL,
             last_search_at = now(),
             next_search_at = EXCLUDED.next_search_at`,
          [rc.canonical_variant_id, rc.shop_id, body.reasonCode],
        );
      }
      await closeCase(client, id, actor.id, 'rejected', body.note ?? null);
    });

    // Az elutasitas ajanlatot VESZ LE a piacrol - ez is ujraepitest kivan.
    await requestPublicationRebuild(enqueueRebuild, 'review_rejected', req.correlationId);

    await audit({
      actorUserId: actor.id, action: 'review.rejected', entityType: 'review_case', entityId: id,
      summary: `${body.reasonCode}: ${body.note ?? ''}`,
      metadata: { canonicalVariantId: rc.canonical_variant_id, sourceListingId: listingId },
      correlationId: req.correlationId,
    });
    return { ok: true };
  });

  app.post('/review-cases/:id/select-candidate', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = decisionBody.extend({ sourceListingId: z.string().uuid() }).parse(req.body);
    const rc = await loadOpenCase(id, body.rowVersion);

    // A nem valasztott jeloltek negativ memoriaba kerulnek
    const candidates = Array.isArray(rc.candidates)
      ? (rc.candidates as Array<{ listingId?: string }>).map((c) => c.listingId).filter(Boolean) as string[]
      : [];
    const rejected = candidates.filter((c) => c !== body.sourceListingId);

    await transaction(async (client) => {
      for (const listingId of rejected) {
        await client.query(
          `INSERT INTO rejected_candidates
             (canonical_variant_id, source_listing_id, shop_id, rejected_by, reviewer_user_id,
              reason_code, reason_note, listing_identity_hash, variant_identity_hash)
           SELECT $1, $2, sl.shop_id, 'human', $3, 'OTHER_CANDIDATE_SELECTED', $4,
                  coalesce(sl.identity_hash, ''), coalesce(cv.identity_hash, '')
             FROM source_listings sl, canonical_variants cv WHERE sl.id = $2 AND cv.id = $1
           ON CONFLICT DO NOTHING`,
          [rc.canonical_variant_id, listingId, actor.id, body.note ?? 'Masik jelolt lett kivalasztva.'],
        );
      }
      // A row_version leptetese kotelezo: enelkul a lapon levo optimista zar
      // csendben elavul, es a kovetkezo dontes egy mar megvaltozott eseten
      // futna le - ugyanabban a keprnyoallapotban, ami mar nem igaz.
      await client.query(
        `UPDATE review_cases SET source_listing_id = $2, row_version = row_version + 1 WHERE id = $1`,
        [id, body.sourceListingId],
      );
    });

    await audit({
      actorUserId: actor.id, action: 'review.candidate_selected', entityType: 'review_case', entityId: id,
      metadata: { selected: body.sourceListingId, rejected }, correlationId: req.correlationId,
    });
    return { ok: true, selected: body.sourceListingId, autoRejected: rejected.length };
  });

  app.post('/review-cases/:id/mark-not-found', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = decisionBody.extend({ note: z.string().min(3, 'Az indoklas kotelezo.') }).parse(req.body);
    const rc = await loadOpenCase(id, body.rowVersion);

    await transaction(async (client) => {
      if (rc.canonical_variant_id && rc.shop_id) {
        await client.query(
          `INSERT INTO variant_shop_status
             (canonical_variant_id, shop_id, status, last_search_at, last_full_search_at,
              primary_reason_code, next_search_at)
           VALUES ($1, $2, 'not_found_after_full_search', now(), now(), 'MANUAL_NOT_FOUND',
                   now() + interval '30 days')
           ON CONFLICT (canonical_variant_id, shop_id)
           DO UPDATE SET status = 'not_found_after_full_search', last_full_search_at = now(),
                         primary_reason_code = 'MANUAL_NOT_FOUND',
                         next_search_at = now() + interval '30 days'`,
          [rc.canonical_variant_id, rc.shop_id],
        );
      }
      await closeCase(client, id, actor.id, 'not_found', body.note);
    });

    await audit({
      actorUserId: actor.id, action: 'review.marked_not_found', entityType: 'review_case', entityId: id,
      summary: body.note, correlationId: req.correlationId,
    });
    return { ok: true };
  });

  app.post('/review-cases/:id/defer', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = decisionBody.extend({ days: z.number().int().min(1).max(90).default(7) }).parse(req.body ?? {});
    await assertRowVersion('review_cases', id, body.rowVersion);
    await execute(
      `UPDATE review_cases
          SET status = 'deferred', deferred_until = now() + ($2 || ' days')::interval,
              row_version = row_version + 1
        WHERE id = $1`,
      [id, String(body.days)],
    );
    await execute(
      `INSERT INTO review_case_events (review_case_id, actor_user_id, action, note)
       VALUES ($1,$2,'deferred',$3)`,
      [id, actor.id, body.note ?? `Elhalasztva ${body.days} nappal.`],
    );
    return { ok: true, deferredDays: body.days };
  });

  app.post('/review-cases/:id/assign', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ userId: z.string().uuid().nullable() }).parse(req.body);
    await execute(
      `UPDATE review_cases SET assignee_user_id = $2,
              status = CASE WHEN $2 IS NULL THEN 'open' ELSE 'in_progress' END,
              row_version = row_version + 1
        WHERE id = $1`,
      [id, body.userId],
    );
    await execute(
      `INSERT INTO review_case_events (review_case_id, actor_user_id, action, payload)
       VALUES ($1,$2,'assigned',$3)`,
      [id, actor.id, JSON.stringify({ assignee: body.userId })],
    );
    return { ok: true };
  });

  /** A kanonikus identitas javitasa -> ujraparositas minden webshopra (spec 16.5). */
  app.post('/review-cases/:id/edit-canonical-and-rerun', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      note: z.string().min(3),
      rowVersion: z.number().int().optional(),
      changes: z.record(z.unknown()),
    }).parse(req.body);
    const rc = await loadOpenCase(id, body.rowVersion);
    if (!rc.canonical_variant_id) throw new AppError('INVALID_CASE', 'Az esethez nem tartozik kanonikus termek.', 400);

    const allowed: Record<string, string> = {
      displayName: 'canonical_display_name', vintageValue: 'vintage_value',
      vintageStatus: 'vintage_status', volumeMl: 'volume_ml', packCount: 'pack_count',
      packagingType: 'packaging_type', edition: 'edition', ageStatementYears: 'age_statement_years',
      abvPercent: 'abv_percent', gtin: 'gtin', puttony: 'puttony', dosageStyle: 'dosage_style',
    };
    const updates: string[] = [];
    const params: unknown[] = [rc.canonical_variant_id];
    for (const [key, column] of Object.entries(allowed)) {
      if (body.changes[key] !== undefined) {
        params.push(body.changes[key]);
        updates.push(`${column} = $${params.length}`);
      }
    }
    if (!updates.length) throw new AppError('NO_CHANGES', 'Nincs ervenyes modositando mezo.', 400);
    updates.push('version = version + 1');

    const before = await queryOne('SELECT * FROM canonical_variants WHERE id = $1', [rc.canonical_variant_id]);
    await execute(`UPDATE canonical_variants SET ${updates.join(', ')} WHERE id = $1`, params);
    await execute(
      `UPDATE variant_shop_status SET status = 'unsearched', next_search_at = now()
        WHERE canonical_variant_id = $1`,
      [rc.canonical_variant_id],
    );
    await execute(
      `INSERT INTO review_case_events (review_case_id, actor_user_id, action, note, payload)
       VALUES ($1,$2,'canonical_fixed',$3,$4)`,
      [id, actor.id, body.note, JSON.stringify(body.changes)],
    );
    await enqueue({
      redisUrl: config.REDIS_URL, queue: 'candidate-generation', name: 'search-all-shops',
      payload: { canonicalVariantId: rc.canonical_variant_id, trigger: 'canonical_fixed' },
      idempotencyKey: `search:${rc.canonical_variant_id}:fixed:${Date.now()}`,
      priority: JOB_PRIORITY['manual-search'], correlationId: req.correlationId,
    }).catch(() => undefined);

    await audit({
      actorUserId: actor.id, action: 'review.canonical_fixed', entityType: 'canonical_variant',
      entityId: rc.canonical_variant_id, before, after: body.changes, summary: body.note,
      correlationId: req.correlationId,
    });
    return { ok: true, rematchQueued: true };
  });

  /** Uj kanonikus valtozat letrehozasa ebbol a listingbol (spec 24.3). */
  app.post('/review-cases/:id/promote-listing', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = decisionBody.parse(req.body ?? {});
    const rc = await loadOpenCase(id, body.rowVersion);
    if (!rc.source_listing_id) throw new AppError('INVALID_CASE', 'Az esethez nem tartozik listing.', 400);

    const job = await enqueue({
      redisUrl: config.REDIS_URL, queue: 'product-ingest', name: 'promote-listing-to-variant',
      payload: { sourceListingId: rc.source_listing_id, actorUserId: actor.id, reviewCaseId: id },
      idempotencyKey: `promote:${rc.source_listing_id}`,
      priority: JOB_PRIORITY['manual-search'], correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'review.promote_listing', entityType: 'source_listing',
      entityId: rc.source_listing_id, correlationId: req.correlationId,
    });
    return { accepted: true, jobId: job.jobId, deduped: job.deduped, state: job.state, waiting: job.waiting };
  });

  /** Alias-javaslat letrehozasa. A promocio KULON adminmuvelet (spec 8.10). */
  app.post('/review-cases/:id/propose-alias', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      aliasType: z.enum(['brand', 'producer', 'expression', 'packaging', 'unit', 'category']),
      aliasText: z.string().min(2),
      targetKind: z.enum(['brand', 'producer', 'canonical_variant', 'product_family', 'category', 'literal']),
      targetId: z.string().uuid().optional(),
      targetLiteral: z.string().optional(),
      shopScoped: z.boolean().default(true),
      note: z.string().optional(),
    }).parse(req.body);

    const rc = await queryOne<{ shop_id: string | null }>('SELECT shop_id FROM review_cases WHERE id = $1', [id]);
    const created = await queryOne<{ id: string }>(
      `INSERT INTO aliases
         (alias_type, alias_text, target_kind, target_id, target_literal, shop_id,
          source, approved, proposed_by, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,'review_promotion', false, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        body.aliasType, body.aliasText, body.targetKind, body.targetId ?? null,
        body.targetLiteral ?? null, body.shopScoped ? rc?.shop_id ?? null : null,
        actor.id, JSON.stringify([{ source: 'review_case', reviewCaseId: id, note: body.note ?? null }]),
      ],
    );
    await audit({
      actorUserId: actor.id, action: 'alias.proposed', entityType: 'alias', entityId: created?.id ?? null,
      summary: `${body.aliasType}: ${body.aliasText}`, correlationId: req.correlationId,
    });
    return {
      ok: true, aliasId: created?.id ?? null, approved: false,
      message: 'Az alias-javaslat letrejott. Globalis ervenyesseghez kulon admin jovahagyas szukseges.',
    };
  });

  // ── Dontesi audit (spec 21.4) ────────────────────────────────────────────
  app.get('/matches/:id/audit', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const decisions = await query(
      `SELECT md.*, u.display_name AS reviewer_name, s.key AS shop_key, s.name AS shop_name,
              sl.raw_name AS listing_name, sl.canonical_url
         FROM match_decisions md
         LEFT JOIN users u ON u.id = md.reviewer_user_id
         LEFT JOIN shops s ON s.id = md.shop_id
         LEFT JOIN source_listings sl ON sl.id = md.source_listing_id
        WHERE md.match_relation_id = $1 OR md.id = $1
        ORDER BY md.created_at DESC`,
      [id],
    );
    if (!decisions.length) throw new AppError('NOT_FOUND', 'Nincs dontesi elozmeny.', 404);
    return { decisions, reasonLabels: REASON_CODE_HU };
  });
}

// ── Segedek ────────────────────────────────────────────────────────────────

