/**
 * Beallitasok, aliasok, auditnaplo, egeszsegellenorzes (spec 21.7, 28., 30.).
 *
 * Minden valtozas verziozott es auditalt. Kritikus matching-policy modositas
 * csak teszteredmeny es admin-jovahagyas utan aktivalhato.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { execute, query, queryOne } from '@radovin/db';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import { requireAtLeast, requireRole } from '../lib/auth.js';
import {
  audit, invalidateSettings, invalidateTaxonomy, loadSettings,
  pageParams, paginated,
} from '../lib/context.js';

/** Ezek a kulcsok csak golden kiertekelessel es admin jovahagyassal valtoztathatok. */
const CRITICAL_SETTINGS = new Set([
  'matching.thresholds',
  'matching.field_weights',
  'quality_gate.shop',
  'retention',
]);

export async function settingsRoutes(app: FastifyInstance, _config: AppConfig): Promise<void> {
  // ── Beallitasok ──────────────────────────────────────────────────────────
  app.get('/settings', async (req) => {
    requireAtLeast(req.user, 'source_manager');
    const items = await query(
      `SELECT DISTINCT ON (key) key, version, value, description, requires_approval,
              approved_at, created_at, active
         FROM settings WHERE active ORDER BY key, version DESC`,
    );
    const flags = await query('SELECT key, enabled, description, updated_at FROM feature_flags ORDER BY key');
    const critical = [...CRITICAL_SETTINGS];
    return { items, flags, criticalKeys: critical };
  });

  app.get('/settings/:key/history', async (req) => {
    requireAtLeast(req.user, 'source_manager');
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const items = await query(
      `SELECT s.version, s.value, s.active, s.created_at, s.approved_at,
              cu.display_name AS created_by_name, au.display_name AS approved_by_name
         FROM settings s
         LEFT JOIN users cu ON cu.id = s.created_by
         LEFT JOIN users au ON au.id = s.approved_by
        WHERE s.key = $1 ORDER BY s.version DESC`,
      [key],
    );
    return { key, items };
  });

  app.put('/settings/:key', async (req) => {
    const actor = requireAtLeast(req.user, 'source_manager');
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const body = z.object({
      value: z.unknown(),
      note: z.string().optional(),
      goldenEvaluationId: z.string().uuid().optional(),
    }).parse(req.body);

    const current = await queryOne<{ version: number; value: unknown }>(
      'SELECT version, value FROM settings WHERE key = $1 AND active', [key],
    );
    if (!current) throw new AppError('UNKNOWN_SETTING', `Ismeretlen beallitas: ${key}`, 404);

    // Kritikus policy: admin + friss, sikeres golden kiertekeles (spec 28.)
    if (CRITICAL_SETTINGS.has(key)) {
      requireRole(req.user, 'admin');
      if (!body.goldenEvaluationId) {
        throw new AppError(
          'GOLDEN_EVALUATION_REQUIRED',
          'Kritikus matching-policy modositasahoz sikeres golden kiertekeles azonositoja szukseges (spec 28., 32.).',
          400,
        );
      }
      const evaluation = await queryOne<{ passed: boolean; run_at: Date }>(
        'SELECT passed, run_at FROM golden_evaluations WHERE id = $1', [body.goldenEvaluationId],
      );
      if (!evaluation) throw new AppError('UNKNOWN_EVALUATION', 'A hivatkozott golden kiertekeles nem talalhato.', 404);
      if (!evaluation.passed) {
        throw new AppError('GOLDEN_EVALUATION_FAILED', 'A hivatkozott golden kiertekeles nem ment at az elfogadasi celokon.', 409);
      }
      const ageDays = (Date.now() - new Date(evaluation.run_at).getTime()) / 86_400_000;
      if (ageDays > 14) {
        throw new AppError('GOLDEN_EVALUATION_STALE', 'A hivatkozott golden kiertekeles 14 napnal regebbi. Futtasd ujra.', 409);
      }
    }

    await execute('UPDATE settings SET active = false WHERE key = $1 AND active', [key]);
    await execute(
      `INSERT INTO settings (key, version, value, description, requires_approval,
                             approved_by, approved_at, created_by, active)
       SELECT $1, $2, $3, description, requires_approval, $4, now(), $4, true
         FROM settings WHERE key = $1 AND version = $5`,
      [key, current.version + 1, JSON.stringify(body.value), actor.id, current.version],
    );

    invalidateSettings();
    await audit({
      actorUserId: actor.id, action: 'settings.updated', entityType: 'setting', entityId: key,
      before: current.value, after: body.value, summary: body.note ?? undefined,
      metadata: { goldenEvaluationId: body.goldenEvaluationId }, correlationId: req.correlationId,
    });
    return { ok: true, key, version: current.version + 1 };
  });

  app.put('/feature-flags/:key', async (req) => {
    const actor = requireRole(req.user, 'admin');
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const body = z.object({ enabled: z.boolean(), note: z.string().optional() }).parse(req.body);

    const before = await queryOne<{ enabled: boolean }>('SELECT enabled FROM feature_flags WHERE key = $1', [key]);
    if (!before) throw new AppError('UNKNOWN_FLAG', `Ismeretlen feature flag: ${key}`, 404);

    await execute(
      'UPDATE feature_flags SET enabled = $2, updated_by = $3, updated_at = now() WHERE key = $1',
      [key, body.enabled, actor.id],
    );
    invalidateSettings();
    await audit({
      actorUserId: actor.id, action: 'feature_flag.updated', entityType: 'feature_flag', entityId: key,
      before, after: { enabled: body.enabled }, summary: body.note ?? undefined, correlationId: req.correlationId,
    });
    return { ok: true, key, enabled: body.enabled };
  });

  // ── Aliasok (spec 8.10) ──────────────────────────────────────────────────
  app.get('/aliases', async (req) => {
    requireAtLeast(req.user, 'catalog_manager');
    const q = z.object({
      approved: z.enum(['true', 'false']).optional(),
      aliasType: z.string().optional(),
      shopId: z.string().uuid().optional(),
      q: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const where: string[] = [];
    const params: unknown[] = [];
    if (q.approved) where.push(`a.approved = $${params.push(q.approved === 'true')}`);
    if (q.aliasType) where.push(`a.alias_type = $${params.push(q.aliasType)}`);
    if (q.shopId) where.push(`a.shop_id = $${params.push(q.shopId)}`);
    if (q.q) where.push(`a.alias_text ILIKE $${params.push(`%${q.q}%`)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [items, countRow] = await Promise.all([
      query(
        `SELECT a.*, s.key AS shop_key, s.name AS shop_name,
                pu.display_name AS proposed_by_name, au.display_name AS approved_by_name,
                coalesce(b.canonical_name, pr.canonical_name, pc.name_hu) AS target_name
           FROM aliases a
           LEFT JOIN shops s ON s.id = a.shop_id
           LEFT JOIN users pu ON pu.id = a.proposed_by
           LEFT JOIN users au ON au.id = a.approved_by
           LEFT JOIN brands b ON b.id = a.target_id AND a.target_kind = 'brand'
           LEFT JOIN producers pr ON pr.id = a.target_id AND a.target_kind = 'producer'
           LEFT JOIN product_categories pc ON pc.id = a.target_id AND a.target_kind = 'category'
           ${whereSql}
          ORDER BY a.approved ASC, a.created_at DESC
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM aliases a ${whereSql}`, params),
    ]);
    return paginated(items, countRow?.total ?? 0, p);
  });

  /**
   * Alias promocio. KULON adminmuvelet - egy parositas jovahagyasa SOHA nem
   * hoz letre automatikusan globalis alias-szabalyt (spec 8.10).
   */
  app.post('/aliases/:id/approve', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      makeGlobal: z.boolean().default(false),
      note: z.string().optional(),
    }).parse(req.body ?? {});

    const alias = await queryOne<{ shop_id: string | null; alias_text: string; alias_type: string }>(
      'SELECT shop_id, alias_text, alias_type FROM aliases WHERE id = $1', [id],
    );
    if (!alias) throw new AppError('NOT_FOUND', 'Az alias nem talalhato.', 404);

    if (body.makeGlobal && alias.shop_id) requireRole(req.user, 'admin');

    await execute(
      `UPDATE aliases
          SET approved = true, approved_by = $2, approved_at = now(),
              shop_id = CASE WHEN $3 THEN NULL ELSE shop_id END
        WHERE id = $1`,
      [id, actor.id, body.makeGlobal],
    );
    invalidateTaxonomy();
    await audit({
      actorUserId: actor.id, action: 'alias.approved', entityType: 'alias', entityId: id,
      summary: `${alias.alias_type}: "${alias.alias_text}"${body.makeGlobal ? ' (globalisra promotalva)' : ''}`,
      metadata: { makeGlobal: body.makeGlobal, note: body.note }, correlationId: req.correlationId,
    });
    return { ok: true, global: body.makeGlobal };
  });

  app.delete('/aliases/:id', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await execute('UPDATE aliases SET active = false WHERE id = $1', [id]);
    invalidateTaxonomy();
    await audit({
      actorUserId: actor.id, action: 'alias.deactivated', entityType: 'alias', entityId: id,
      correlationId: req.correlationId,
    });
    return { ok: true };
  });

  app.post('/negative-aliases', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const body = z.object({
      leftText: z.string().min(2),
      rightText: z.string().min(2),
      categoryKey: z.string().optional(),
      reason: z.string().min(5),
    }).parse(req.body);

    const created = await queryOne<{ id: string }>(
      `INSERT INTO negative_aliases (left_text, right_text, category_id, reason, created_by)
       VALUES ($1,$2,(SELECT id FROM product_categories WHERE key = $3),$4,$5)
       ON CONFLICT DO NOTHING RETURNING id`,
      [body.leftText, body.rightText, body.categoryKey ?? null, body.reason, actor.id],
    );
    invalidateTaxonomy();
    await audit({
      actorUserId: actor.id, action: 'negative_alias.created', entityType: 'negative_alias',
      entityId: created?.id ?? null, summary: `"${body.leftText}" <> "${body.rightText}": ${body.reason}`,
      correlationId: req.correlationId,
    });
    return { ok: true, id: created?.id ?? null };
  });

  app.get('/negative-aliases', async (req) => {
    requireAtLeast(req.user, 'reviewer');
    const items = await query(
      `SELECT na.*, pc.key AS category_key, u.display_name AS created_by_name
         FROM negative_aliases na
         LEFT JOIN product_categories pc ON pc.id = na.category_id
         LEFT JOIN users u ON u.id = na.created_by
        ORDER BY na.created_at DESC LIMIT 500`,
    );
    return { items };
  });

  // ── Auditnaplo (spec 22.1/10) ────────────────────────────────────────────
  app.get('/audit-log', async (req) => {
    requireAtLeast(req.user, 'source_manager');
    const q = z.object({
      action: z.string().optional(),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      actorUserId: z.string().uuid().optional(),
      days: z.coerce.number().int().min(1).max(365).default(30),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const where = [`a.occurred_at > now() - ($1 || ' days')::interval`];
    const params: unknown[] = [String(q.days)];
    if (q.action) where.push(`a.action = $${params.push(q.action)}`);
    if (q.entityType) where.push(`a.entity_type = $${params.push(q.entityType)}`);
    if (q.entityId) where.push(`a.entity_id = $${params.push(q.entityId)}`);
    if (q.actorUserId) where.push(`a.actor_user_id = $${params.push(q.actorUserId)}`);
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [items, countRow] = await Promise.all([
      query(
        `SELECT a.*, u.display_name AS actor_name, u.email AS actor_email
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
           ${whereSql} ORDER BY a.occurred_at DESC
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM audit_log a ${whereSql}`, params),
    ]);
    return paginated(items, countRow?.total ?? 0, p);
  });

  // ── Riasztasok ───────────────────────────────────────────────────────────
  app.get('/alerts', async (req) => {
    requireAtLeast(req.user, 'reviewer');
    const q = z.object({
      resolved: z.enum(['true', 'false']).default('false'),
      level: z.string().optional(),
    }).parse(req.query);
    const where = [q.resolved === 'true' ? 'a.resolved_at IS NOT NULL' : 'a.resolved_at IS NULL'];
    const params: unknown[] = [];
    if (q.level) where.push(`a.level = $${params.push(q.level)}`);
    const items = await query(
      `SELECT a.*, s.key AS shop_key, s.name AS shop_name
         FROM alerts a LEFT JOIN shops s ON s.id = a.shop_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE a.level WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
                 a.last_seen_at DESC LIMIT 300`,
      params,
    );
    return { items };
  });

  app.post('/alerts/:id/acknowledge', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await execute('UPDATE alerts SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1', [id, actor.id]);
    return { ok: true };
  });

  app.post('/alerts/:id/resolve', async (req) => {
    const actor = requireAtLeast(req.user, 'source_manager');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await execute('UPDATE alerts SET resolved_at = now() WHERE id = $1', [id]);
    await audit({
      actorUserId: actor.id, action: 'alert.resolved', entityType: 'alert', entityId: id,
      correlationId: req.correlationId,
    });
    return { ok: true };
  });

  // ── Golden dataset kiertekelesek (spec 32.) ─────────────────────────────
  app.get('/golden/evaluations', async (req) => {
    requireAtLeast(req.user, 'reviewer');
    const items = await query('SELECT * FROM golden_evaluations ORDER BY run_at DESC LIMIT 50');
    const counts = await query<{ label: string; count: number }>(
      `SELECT label, count(*)::int AS count FROM golden_pairs WHERE active GROUP BY label`,
    );
    return { items, datasetCounts: counts };
  });

  app.get('/golden/pairs', async (req) => {
    requireAtLeast(req.user, 'reviewer');
    const q = z.object({
      label: z.string().optional(),
      caseGroup: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);
    const where = ['active'];
    const params: unknown[] = [];
    if (q.label) where.push(`label = $${params.push(q.label)}`);
    if (q.caseGroup) where.push(`case_group = $${params.push(q.caseGroup)}`);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const [items, countRow] = await Promise.all([
      query(`SELECT * FROM golden_pairs ${whereSql} ORDER BY created_at DESC LIMIT ${p.pageSize} OFFSET ${p.offset}`, params),
      queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM golden_pairs ${whereSql}`, params),
    ]);
    return paginated(items, countRow?.total ?? 0, p);
  });

  app.post('/golden/pairs', async (req) => {
    const actor = requireAtLeast(req.user, 'reviewer');
    const body = z.object({
      label: z.enum(['positive', 'hard_negative', 'no_match']),
      categoryKey: z.string().optional(),
      caseGroup: z.string().optional(),
      leftKind: z.enum(['canonical_variant', 'source_listing', 'fixture']),
      leftRef: z.string(),
      rightKind: z.enum(['canonical_variant', 'source_listing', 'fixture', 'none']),
      rightRef: z.string().optional(),
      expectedReasonCodes: z.array(z.string()).default([]),
      notes: z.string().optional(),
    }).parse(req.body);

    const created = await queryOne<{ id: string }>(
      `INSERT INTO golden_pairs
         (label, category_key, case_group, left_kind, left_ref, right_kind, right_ref,
          expected_reason_codes, notes, verified_by, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING id`,
      [
        body.label, body.categoryKey ?? null, body.caseGroup ?? null,
        body.leftKind, body.leftRef, body.rightKind, body.rightRef ?? null,
        body.expectedReasonCodes, body.notes ?? null, actor.id,
      ],
    );
    await audit({
      actorUserId: actor.id, action: 'golden.pair_added', entityType: 'golden_pair',
      entityId: created!.id, summary: `${body.label}: ${body.leftRef} / ${body.rightRef ?? '-'}`,
      correlationId: req.correlationId,
    });
    return { ok: true, id: created!.id };
  });

  // ── Mentett nezetek (spec 22.2) ─────────────────────────────────────────
  app.get('/saved-views', async (req) => {
    const user = req.user;
    if (!user) throw new AppError('UNAUTHENTICATED', 'Bejelentkezes szukseges.', 401);
    return { items: await query('SELECT * FROM saved_views WHERE user_id = $1 ORDER BY scope, name', [user.id]) };
  });

  app.post('/saved-views', async (req) => {
    const user = req.user;
    if (!user) throw new AppError('UNAUTHENTICATED', 'Bejelentkezes szukseges.', 401);
    const body = z.object({
      scope: z.string(), name: z.string().min(1).max(80),
      filters: z.record(z.unknown()), isDefault: z.boolean().default(false),
    }).parse(req.body);
    await execute(
      `INSERT INTO saved_views (user_id, scope, name, filters, is_default)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, scope, name)
       DO UPDATE SET filters = EXCLUDED.filters, is_default = EXCLUDED.is_default`,
      [user.id, body.scope, body.name, JSON.stringify(body.filters), body.isDefault],
    );
    return { ok: true };
  });

  app.delete('/saved-views/:id', async (req) => {
    const user = req.user;
    if (!user) throw new AppError('UNAUTHENTICATED', 'Bejelentkezes szukseges.', 401);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await execute('DELETE FROM saved_views WHERE id = $1 AND user_id = $2', [id, user.id]);
    return { ok: true };
  });

  // ── Metrikak (spec 30.2) ────────────────────────────────────────────────
  app.get('/metrics/summary', async (req) => {
    requireAtLeast(req.user, 'reviewer');
    const settings = await loadSettings();
    const [matching, crawling, business] = await Promise.all([
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM match_relations WHERE status = 'verified' AND valid_to IS NULL)      AS verified_total,
           (SELECT count(*)::int FROM match_relations
             WHERE status = 'verified' AND verified_kind = 'auto_verified' AND valid_to IS NULL)           AS auto_verified,
           (SELECT count(*)::int FROM match_relations
             WHERE status = 'verified' AND verified_kind = 'human_verified' AND valid_to IS NULL)          AS human_verified,
           (SELECT count(*)::int FROM review_cases WHERE status IN ('open','in_progress'))                 AS review_open,
           (SELECT count(*)::int FROM review_cases WHERE resolution = 'approved')                          AS review_approved,
           (SELECT count(*)::int FROM review_cases WHERE resolution = 'rejected')                          AS review_rejected,
           (SELECT count(*)::int FROM match_decisions WHERE status = 'ambiguous')                          AS ambiguous,
           (SELECT count(*)::int FROM match_decisions WHERE status = 'insufficient_evidence')              AS insufficient,
           (SELECT count(*)::int FROM match_relations WHERE status = 'drifted')                            AS drifted,
           (SELECT round(avg(top_margin)::numeric, 4) FROM match_decisions
             WHERE top_margin IS NOT NULL AND created_at > now() - interval '30 days')                      AS avg_top_margin`,
      ),
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM crawl_runs WHERE started_at > now() - interval '7 days')             AS runs_7d,
           (SELECT count(*)::int FROM crawl_runs
             WHERE started_at > now() - interval '7 days' AND status = 'succeeded')                        AS runs_succeeded_7d,
           (SELECT count(*)::int FROM crawl_runs
             WHERE started_at > now() - interval '7 days' AND status = 'quarantined')                      AS runs_quarantined_7d,
           (SELECT sum(requests_attempted)::int FROM crawl_runs
             WHERE started_at > now() - interval '7 days')                                                 AS requests_7d,
           (SELECT sum(rate_limit_hits)::int FROM crawl_runs
             WHERE started_at > now() - interval '7 days')                                                 AS rate_limits_7d,
           (SELECT round(
              (sum(extract_ok)::numeric / NULLIF(sum(extract_ok + extract_failed), 0)), 4)
              FROM crawl_runs WHERE started_at > now() - interval '7 days')                                AS extraction_success_rate`,
      ),
      queryOne(
        `SELECT
           (SELECT count(*)::int FROM canonical_variants WHERE status = 'active')                          AS variants,
           (SELECT count(*)::int FROM tracked_products WHERE active)                                        AS tracked,
           (SELECT round(avg(shop_count)::numeric, 2) FROM market_variant_summary ms
              JOIN v_current_publication p ON p.id = ms.publication_id)                                     AS avg_shops_per_variant,
           (SELECT count(*)::int FROM v_market_offers WHERE NOT stale)                                      AS fresh_offers,
           (SELECT count(*)::int FROM v_market_offers WHERE stale)                                          AS stale_offers`,
      ),
    ]);
    return {
      matching, crawling, business,
      policy: {
        autoMatchEnabled: settings.flags.get('auto_match') ?? false,
        autoMatchIdentifierOnly: settings.flags.get('auto_match_identifier_only') ?? true,
        thresholds: settings.settings.get('matching.thresholds'),
      },
    };
  });
}
