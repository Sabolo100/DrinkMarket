/**
 * Kozos API-segedek: auditnaplo, lapozas, beallitasok, taxonomia-betoltes,
 * queue-hozzaferes.
 */
import type { FastifyRequest } from 'fastify';
import type { MatchPolicy, SessionUser } from '@radovin/contracts';
import { execute, query, queryOne } from '@radovin/db';
import { Taxonomy, type TaxonomySnapshot } from '@radovin/domain';
import { AppError, logger } from '@radovin/observability';

// ── Audit (spec 21.7, 29.1) ────────────────────────────────────────────────

export interface AuditInput {
  actorUserId?: string | null;
  actorKind?: 'user' | 'system' | 'worker' | 'scheduler' | 'import' | 'migration';
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await execute(
      `INSERT INTO audit_log
         (actor_user_id, actor_kind, action, entity_type, entity_id,
          correlation_id, summary, before_state, after_state, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        input.actorUserId ?? null,
        input.actorKind ?? 'user',
        input.action,
        input.entityType,
        input.entityId ?? null,
        input.correlationId ?? null,
        input.summary ?? null,
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (err) {
    // Az auditnaplo hibaja nem allithatja meg az uzleti muveletet, de logolando
    logger.error('audit.write_failed', {
      action: input.action, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Lapozas (spec 21.7) ────────────────────────────────────────────────────

export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function pageParams(query: Record<string, unknown>, defaultSize = 50, maxSize = 500): PageParams {
  const page = Math.max(1, Number.parseInt(String(query['page'] ?? '1'), 10) || 1);
  const requested = Number.parseInt(String(query['pageSize'] ?? String(defaultSize)), 10) || defaultSize;
  const pageSize = Math.min(maxSize, Math.max(1, requested));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paginated<T>(items: T[], total: number, p: PageParams) {
  return {
    items,
    total,
    page: p.page,
    pageSize: p.pageSize,
    hasMore: p.offset + items.length < total,
  };
}

/** Biztonsagos rendezes: csak allowlisten szereplo oszlop hasznalhato. */
export function safeOrderBy(
  requested: unknown,
  allowed: Record<string, string>,
  fallback: string,
): string {
  const raw = String(requested ?? '').trim();
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  const column = allowed[key];
  if (!column) return fallback;
  return `${column} ${desc ? 'DESC' : 'ASC'} NULLS LAST`;
}

// ── Beallitasok es feature flagek (spec 28.) ───────────────────────────────

interface SettingsCache {
  loadedAt: number;
  settings: Map<string, unknown>;
  flags: Map<string, boolean>;
}

let settingsCache: SettingsCache | null = null;
const SETTINGS_TTL_MS = 30_000;

export async function loadSettings(force = false): Promise<SettingsCache> {
  if (!force && settingsCache && Date.now() - settingsCache.loadedAt < SETTINGS_TTL_MS) {
    return settingsCache;
  }
  const rows = await query<{ key: string; value: unknown }>(
    'SELECT key, value FROM settings WHERE active ORDER BY key, version DESC',
  );
  const flagRows = await query<{ key: string; enabled: boolean }>('SELECT key, enabled FROM feature_flags');
  settingsCache = {
    loadedAt: Date.now(),
    settings: new Map(rows.map((r) => [r.key, r.value])),
    flags: new Map(flagRows.map((r) => [r.key, r.enabled])),
  };
  return settingsCache;
}

export function invalidateSettings(): void {
  settingsCache = null;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const cache = await loadSettings();
  const value = cache.settings.get(key);
  return (value === undefined ? fallback : value) as T;
}

export async function getFlag(key: string, fallback = false): Promise<boolean> {
  const cache = await loadSettings();
  return cache.flags.get(key) ?? fallback;
}

/** Az aktualis matching policy osszeallitasa a beallitasokbol. */
export async function currentMatchPolicy(): Promise<MatchPolicy> {
  const [thresholds, weights, matcherVersion, taxonomyVersion, policyVersion, autoMatch, identifierOnly] =
    await Promise.all([
      getSetting('matching.thresholds', {
        autoMatch: { evidenceCoverage: 0.9, extractionQuality: 0.9, agreementScore: 0.96, topMargin: 0.1 },
        review: { minScore: 0.7 },
        ambiguousMargin: 0.03,
        volumeToleranceMl: 5,
      }),
      getSetting<Record<string, number>>('matching.field_weights', {
        producer: 0.18, expression: 0.28, vintage: 0.16, volume: 0.16,
        category: 0.06, region: 0.06, abv: 0.04, gtin: 0.04, image: 0.02,
      }),
      getSetting('matcher.version', '2.1.0'),
      getSetting('taxonomy.version', '1.0.0'),
      getSetting('policy.version', '2.1.0'),
      getFlag('auto_match', false),
      getFlag('auto_match_identifier_only', true),
    ]);

  return {
    matcherVersion: String(matcherVersion),
    taxonomyVersion: String(taxonomyVersion),
    policyVersion: String(policyVersion),
    autoMatchEnabled: autoMatch,
    autoMatchIdentifierOnly: identifierOnly,
    thresholds: thresholds as MatchPolicy['thresholds'],
    fieldWeights: weights,
  };
}

// ── Taxonomia betoltes (spec 13.3) ─────────────────────────────────────────

let taxonomyCache: { loadedAt: number; taxonomy: Taxonomy } | null = null;
const TAXONOMY_TTL_MS = 60_000;

export async function loadTaxonomy(force = false): Promise<Taxonomy> {
  if (!force && taxonomyCache && Date.now() - taxonomyCache.loadedAt < TAXONOMY_TTL_MS) {
    return taxonomyCache.taxonomy;
  }
  const [brands, producers, categories, aliases, negatives, terms, version] = await Promise.all([
    query<{ id: string; canonical_name: string; name_norm: string; producer_id: string | null; category_id: string | null; fuzzy_blocked: boolean }>(
      `SELECT id, canonical_name, name_norm, producer_id, category_id, fuzzy_blocked
         FROM brands WHERE status = 'active'`),
    query<{ id: string; canonical_name: string; name_norm: string; fuzzy_blocked: boolean }>(
      `SELECT id, canonical_name, name_norm, fuzzy_blocked
         FROM producers WHERE status = 'active'`),
    query<{ id: string; key: string; name_norm: string; aliases: string[] }>(
      `SELECT c.id, c.key, rv_search_norm(c.name_hu) AS name_norm,
              coalesce(array_agg(ca.alias) FILTER (WHERE ca.alias IS NOT NULL), '{}') AS aliases
         FROM product_categories c
         LEFT JOIN category_aliases ca ON ca.category_id = c.id AND ca.approved
        WHERE c.active
        GROUP BY c.id, c.key, c.name_hu`),
    query<{ alias_type: string; alias_norm: string; target_kind: string; target_id: string | null; target_literal: string | null; shop_id: string | null; approved: boolean }>(
      `SELECT alias_type, alias_norm, target_kind, target_id, target_literal, shop_id, approved
         FROM aliases WHERE approved AND active`),
    query<{ left_norm: string; right_norm: string; category_key: string | null; reason: string }>(
      `SELECT na.left_norm, na.right_norm, pc.key AS category_key, na.reason
         FROM negative_aliases na
         LEFT JOIN product_categories pc ON pc.id = na.category_id`),
    query<{ term_norm: string; term_class: string; category_key: string | null }>(
      `SELECT it.term_norm, it.term_class, pc.key AS category_key
         FROM identity_terms it
         LEFT JOIN product_categories pc ON pc.id = it.category_id
        WHERE it.active`),
    getSetting('taxonomy.version', '1.0.0'),
  ]);

  const snapshot: TaxonomySnapshot = {
    brands: brands.map((b) => ({
      id: b.id, canonicalName: b.canonical_name, nameNorm: b.name_norm,
      producerId: b.producer_id, categoryId: b.category_id, fuzzyBlocked: b.fuzzy_blocked,
    })),
    producers: producers.map((p) => ({
      id: p.id, canonicalName: p.canonical_name, nameNorm: p.name_norm, fuzzyBlocked: p.fuzzy_blocked,
    })),
    categories: categories.map((c) => ({ id: c.id, key: c.key, nameNorm: c.name_norm, aliases: c.aliases })),
    aliases: aliases.map((a) => ({
      aliasType: a.alias_type as never, aliasNorm: a.alias_norm, targetKind: a.target_kind,
      targetId: a.target_id, targetLiteral: a.target_literal, shopId: a.shop_id, approved: a.approved,
    })),
    negativeAliases: negatives.map((n) => ({
      leftNorm: n.left_norm, rightNorm: n.right_norm, categoryKey: n.category_key, reason: n.reason,
    })),
    identityTerms: terms.map((t) => ({ termNorm: t.term_norm, termClass: t.term_class, categoryKey: t.category_key })),
    version: String(version),
  };

  const taxonomy = new Taxonomy(snapshot);
  taxonomyCache = { loadedAt: Date.now(), taxonomy };
  return taxonomy;
}

export function invalidateTaxonomy(): void {
  taxonomyCache = null;
}

// ── Optimistic locking (spec 19.5) ─────────────────────────────────────────

export async function assertRowVersion(
  table: 'review_cases',
  id: string,
  expected: number | undefined,
): Promise<number> {
  const row = await queryOne<{ row_version: number }>(
    `SELECT row_version FROM ${table} WHERE id = $1`,
    [id],
  );
  if (!row) throw new AppError('NOT_FOUND', 'A rekord nem talalhato.', 404);
  if (expected !== undefined && row.row_version !== expected) {
    throw new AppError(
      'VERSION_CONFLICT',
      `A rekordot idokozben modositottak (varhato verzio: ${expected}, aktualis: ${row.row_version}). Toltsd ujra.`,
      409,
      { currentVersion: row.row_version },
    );
  }
  return row.row_version;
}

// ── Idempotencia (spec 21.4) ───────────────────────────────────────────────

const idempotencyCache = new Map<string, { at: number; result: unknown }>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export function rememberIdempotent(key: string, result: unknown): void {
  idempotencyCache.set(key, { at: Date.now(), result });
  if (idempotencyCache.size > 5000) {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of idempotencyCache) if (v.at < cutoff) idempotencyCache.delete(k);
  }
}

export function recallIdempotent(key: string | undefined): unknown | undefined {
  if (!key) return undefined;
  const hit = idempotencyCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(key);
    return undefined;
  }
  return hit.result;
}

export function currentUser(req: FastifyRequest): SessionUser | null {
  return (req as FastifyRequest & { user?: SessionUser | null }).user ?? null;
}
