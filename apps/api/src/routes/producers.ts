/**
 * Boraszatok: javaslatok jovahagyasa es az eles torzs kezelese.
 *
 * A `producers` tabla ures volt, es a bor kategoriaban a `producer` KOTELEZO
 * mezo - amig ures, egyetlen borparositas sem tud sikerulni. A banyaszat a
 * korpuszbol allit elo jelolteket, de azok kizarolag `status = 'proposed'`
 * allapotban keletkeznek: eles adatta CSAK emberi jovahagyassal valnak
 * (spec 8.10 - a jovahagyas sosem automatikus).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { execute, query, queryOne } from '@radovin/db';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import { requireAtLeast } from '../lib/auth.js';
import { audit, pageParams } from '../lib/context.js';
import { enqueue, JOB_PRIORITY } from '../lib/queues.js';

export async function producerRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // ── Jeloltek es eles boraszatok listaja ──────────────────────────────────
  app.get('/producers', async (req) => {
    requireAtLeast(req.user, 'catalog_manager');
    const q = z.object({
      status: z.enum(['proposed', 'active', 'retired', 'all']).optional(),
      search: z.string().optional(),
      sort: z.enum(['score', 'name', 'listings']).optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query);
    const p_ = pageParams({ ...q, pageSize: q.pageSize ?? q.limit ?? 100 } as Record<string, unknown>);

    const status = q.status ?? 'proposed';
    const params: unknown[] = [];
    const where: string[] = [];
    if (status !== 'all') { params.push(status); where.push(`p.status = $${params.length}`); }
    // A kereses a NORMALIZALT nevre is illeszkedik, kulonben a "Csanyi" nem
    // talalna meg a "Csányi Pincészet"-et - epp azt, amit a felhasznalo ir.
    if (q.search) {
      params.push(`%${q.search}%`);
      params.push(`%${q.search}%`);
      where.push(`(p.canonical_name ILIKE $${params.length - 1}
                   OR p.name_norm LIKE rv_search_norm($${params.length}))`);
    }

    // A rendezes a feladathoz igazodik: a pontszam a banyaszat rangsora, a nev
    // viszont akkor kell, amikor egy KONKRET pinceszetet keresel a listaban.
    const orderBy = q.sort === 'name'
      ? 'p.canonical_name ASC'
      : q.sort === 'listings'
        ? `(p.evidence->>'listings')::int DESC NULLS LAST, p.canonical_name`
        : 'p.candidate_score DESC NULLS LAST, p.canonical_name';

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [items, totalRow] = await Promise.all([
      query(
        `SELECT p.id::text, p.canonical_name, p.status, p.kind, p.fuzzy_blocked,
                p.candidate_score, p.evidence, p.proposed_at, p.decided_at,
                p.applied_at, p.applied_listing_count,
                (SELECT count(*)::int FROM source_listings sl WHERE sl.producer_id = p.id) AS linked_listings
           FROM producers p
           ${whereSql}
          ORDER BY ${orderBy}
          LIMIT ${p_.pageSize} OFFSET ${p_.offset}`,
        params,
      ),
      queryOne<{ total: number }>(
        `SELECT count(*)::int AS total FROM producers p ${whereSql}`,
        params,
      ),
    ]);

    const counts = await query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM producers GROUP BY status`,
    );

    // Jovahagyva, de a katalogusra meg nem alkalmazva. Ez sajat allapot: a
    // jovahagyas onmagaban nem tolti ki a listingek termelojet, ahhoz egy
    // ujrakinyeres kell a mar tarolt nevekbol.
    const pending = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM producers
        WHERE status = 'active' AND applied_at IS NULL`,
    );

    return {
      items,
      total: totalRow?.total ?? 0,
      page: p_.page,
      pageSize: p_.pageSize,
      hasMore: p_.offset + items.length < (totalRow?.total ?? 0),
      counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
      pendingApply: pending?.count ?? 0,
    };
  });

  // ── Jovahagyas ───────────────────────────────────────────────────────────
  //
  // A `fuzzy_blocked` a szemelynev-alapu pinceszeteknel kotelezo (spec 13.3):
  // a "Gere Attila" es a "Gere Zsolt" KET KULON boraszat, a trigram-
  // hasonlosaguk viszont magas. A jovahagyo felulirhatja, de az alapertelmezes
  // a banyaszat szemelynev-felismeresebol jon.
  app.post('/producers/:id/approve', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      canonicalName: z.string().min(2).max(200).optional(),
      fuzzyBlocked: z.boolean().optional(),
      kind: z.enum(['winery', 'distillery', 'producer', 'importer', 'unknown']).optional(),
    }).parse(req.body ?? {});

    const existing = await queryOne<{ canonical_name: string; status: string }>(
      'SELECT canonical_name, status FROM producers WHERE id = $1', [id],
    );
    if (!existing) throw new AppError('NOT_FOUND', 'A boraszat nem talalhato.', 404);
    if (existing.status === 'active') {
      throw new AppError('ALREADY_ACTIVE', 'Ez a boraszat mar jova van hagyva.', 409);
    }

    await execute(
      `UPDATE producers SET
         status = 'active',
         canonical_name = coalesce($2, canonical_name),
         fuzzy_blocked = coalesce($3, fuzzy_blocked),
         kind = coalesce($4, kind),
         decided_by = $5, decided_at = now()
       WHERE id = $1`,
      [id, body.canonicalName ?? null, body.fuzzyBlocked ?? null, body.kind ?? null, actor.id],
    );

    await audit({
      actorUserId: actor.id, action: 'producer.approved', entityType: 'producer', entityId: id,
      summary: `Boraszat jovahagyva: ${body.canonicalName ?? existing.canonical_name}`,
      correlationId: req.correlationId,
    });

    // A jovahagyas onmagaban nem valtoztat a mar begyujtott terméklistán:
    // a listingek `producer_id`-ja uresen marad, amig valaki ujra ki nem
    // nyeri az azonossagot a tarolt nevbol. Ezt inditjuk el itt - ujracrawl
    // nelkul, mert a nevhez mar nem kell a webshop.
    //
    // A kozos idempotencia-kulcs es a rovid kesleltetes szandekos: aki
    // egymas utan hagy jova tiz boraszatot, annak EGY futas dolgozza fel
    // mind a tizet, nem tiz kulon.
    const apply = await enqueueApply(config, req.correlationId);

    return { ok: true, apply };
  });

  // ── Elutasitas ───────────────────────────────────────────────────────────
  //
  // A sort NEM toroljuk, hanem `retired` allapotba tesszuk: igy egy kesobbi
  // banyaszat nem javasolja ujra ugyanazt, es a dontes auditalhato marad.
  app.post('/producers/:id/reject', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});

    const existing = await queryOne<{ canonical_name: string; status: string }>(
      'SELECT canonical_name, status FROM producers WHERE id = $1', [id],
    );
    if (!existing) throw new AppError('NOT_FOUND', 'A boraszat nem talalhato.', 404);
    if (existing.status === 'active') {
      throw new AppError('ACTIVE_PRODUCER', 'Aktiv boraszatot nem lehet elutasitani; elobb vissza kell vonni.', 409);
    }

    await execute(
      `UPDATE producers SET status = 'retired', notes = coalesce($2, notes),
              decided_by = $3, decided_at = now()
        WHERE id = $1`,
      [id, body.reason ?? null, actor.id],
    );
    await audit({
      actorUserId: actor.id, action: 'producer.rejected', entityType: 'producer', entityId: id,
      summary: `Boraszatjelolt elutasitva: ${existing.canonical_name}`,
      correlationId: req.correlationId,
    });
    return { ok: true };
  });

  // ── Jovahagyas visszavonasa ──────────────────────────────────────────────
  app.post('/producers/:id/revoke', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const linked = await queryOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM source_listings WHERE producer_id = $1', [id],
    );
    if ((linked?.count ?? 0) > 0) {
      throw new AppError(
        'PRODUCER_IN_USE',
        `A boraszat ${linked?.count} listinghez van kotve. Elobb azokat kell feloldani.`,
        409, { linkedListings: linked?.count },
      );
    }

    await execute(
      `UPDATE producers SET status = 'proposed', decided_by = $2, decided_at = now() WHERE id = $1`,
      [id, actor.id],
    );
    await audit({
      actorUserId: actor.id, action: 'producer.revoked', entityType: 'producer', entityId: id,
      summary: 'Boraszat jovahagyasa visszavonva', correlationId: req.correlationId,
    });
    return { ok: true };
  });

  // ── A jovahagyasok hatalyba leptetese ────────────────────────────────────
  //
  // Ket mod: alapbol csak a meg nem alkalmazott jovahagyasokra fut, a
  // `rebuildAll` viszont minden aktiv boraszatra ujra. Az utobbi akkor kell,
  // ha kozben bovult a fajta- vagy dulo-szotar.
  app.post('/producers/apply', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const body = z.object({
      rebuildAll: z.boolean().optional(),
      shopKey: z.string().optional(),
      dryRun: z.boolean().optional(),
    }).parse(req.body ?? {});

    const active = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM producers WHERE status = 'active'`,
    );
    if ((active?.count ?? 0) === 0) {
      throw new AppError(
        'NO_ACTIVE_PRODUCERS',
        'Meg egyetlen boraszat sincs jovahagyva - nincs mit alkalmazni.',
        409,
      );
    }

    const job = await enqueue({
      redisUrl: config.REDIS_URL,
      queue: 'product-ingest',
      name: 'reextract-listings',
      payload: {
        ...(body.rebuildAll ? { all: true } : { pendingOnly: true }),
        ...(body.shopKey ? { shopKey: body.shopKey } : {}),
        ...(body.dryRun ? { dryRun: true } : {}),
        actorUserId: actor.id,
      },
      idempotencyKey: body.rebuildAll ? 'reextract-all' : 'reextract-pending',
      priority: JOB_PRIORITY['product-ingest'] ?? 50,
      correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'producer.apply_triggered', entityType: 'producer',
      entityId: null,
      summary: body.rebuildAll
        ? 'Ujrakinyeres minden jovahagyott boraszatra'
        : 'Ujrakinyeres a meg nem alkalmazott jovahagyasokra',
      correlationId: req.correlationId,
    });
    return {
      accepted: true, jobId: job.jobId, deduped: job.deduped,
      state: job.state, waiting: job.waiting,
    };
  });

  // ── Az ujrakinyeres allapota ─────────────────────────────────────────────
  //
  // A gomb megnyomasa utan a felulet egy dolt betus uzenetet mutatott, de az
  // a komponens sajat allapota volt: egy oldalvaltas elmosta. A futas
  // ilyenkor tovabb ment, csak semmi nem mondta meg. Egy husz percig tarto
  // muveletnel ez hasznalhatatlan - az ember nem tudja, varjon-e vagy
  // inditsa ujra (ez utobbi amugy sem tenne semmit, a kozos
  // idempotencia-kulcs elnyelne).
  //
  // A `job_runs` mar eddig is tudta a valaszt; csak nem kerdezte senki.
  app.get('/producers/apply/status', async (req) => {
    requireAtLeast(req.user, 'catalog_manager');

    // A `::text` cast SZANDEKOSAN nincs itt. A Postgres szoveges alakja
    // ("2026-09-04 20:06:37+00") szokozt hasznal, amit a JS `Date` csak
    // motorfuggoen fogad el - Safariban `Invalid Date` lenne belole, es a
    // savon ertelmetlen idot latnank. Igy a driver Date-et ad, a JSON pedig
    // szabvanyos ISO alakot.
    const run = await queryOne<{
      status: string; queued_at: Date; started_at: Date | null;
      finished_at: Date | null; duration_ms: number | null;
      error_message: string | null; result: Record<string, unknown> | null;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT status, queued_at, started_at, finished_at,
              duration_ms, error_message, result, payload
         FROM job_runs
        WHERE queue = 'product-ingest' AND job_name = 'reextract-listings'
        ORDER BY queued_at DESC LIMIT 1`,
    );

    if (!run) return { state: 'never', run: null };

    // A `queued` es a `running` egyarant "dolgozik" a felhasznalo szemszogebol:
    // az elso azt jelenti, hogy mar bekuldtuk, csak meg nem vette fel senki.
    const active = run.status === 'queued' || run.status === 'running';

    return {
      state: active ? 'active' : run.status,
      run: {
        status: run.status,
        queuedAt: run.queued_at.toISOString(),
        startedAt: run.started_at?.toISOString() ?? null,
        finishedAt: run.finished_at?.toISOString() ?? null,
        durationMs: run.duration_ms,
        errorMessage: run.error_message,
        full: Boolean((run.payload as { all?: boolean } | null)?.all),
        result: run.result,
      },
    };
  });

  // ── Banyaszat inditasa ───────────────────────────────────────────────────
  app.post('/producers/mine', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const body = z.object({
      minShops: z.number().int().min(1).max(6).optional(),
      limit: z.number().int().min(10).max(2000).optional(),
    }).parse(req.body ?? {});

    const job = await enqueue({
      redisUrl: config.REDIS_URL,
      queue: 'product-ingest',
      name: 'propose-producers',
      payload: { minShops: body.minShops ?? 2, limit: body.limit ?? 400, actorUserId: actor.id },
      idempotencyKey: 'propose-producers',
      priority: JOB_PRIORITY['product-ingest'] ?? 50,
      correlationId: req.correlationId,
    });
    await audit({
      actorUserId: actor.id, action: 'producer.mine_triggered', entityType: 'producer', entityId: null,
      summary: 'Boraszat-banyaszat inditva', correlationId: req.correlationId,
    });
    return {
      accepted: true, jobId: job.jobId, deduped: job.deduped,
      state: job.state, waiting: job.waiting,
    };
  });
}

/**
 * Az ujrakinyeres sorbaallitasa a jovahagyas utan.
 *
 * A kozos `reextract-pending` kulcs miatt egy varakozo futas elnyeli a
 * kovetkezo jovahagyast is. Ha viszont mar FUT, az uj jovahagyas kimaradna
 * belole - ezt a processzor sajat farok-ellenorzese potolja.
 */
async function enqueueApply(
  config: AppConfig,
  correlationId: string,
): Promise<{ jobId: string; deduped: boolean }> {
  const job = await enqueue({
    redisUrl: config.REDIS_URL,
    queue: 'product-ingest',
    name: 'reextract-listings',
    payload: { pendingOnly: true },
    idempotencyKey: 'reextract-pending',
    priority: JOB_PRIORITY['product-ingest'] ?? 50,
    delayMs: 20_000,
    correlationId,
  });
  return { jobId: job.jobId, deduped: job.deduped };
}
