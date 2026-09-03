/**
 * Webshop-konfiguracio betoltese es taxonomia-cache a workerekhez.
 */
import type { CrawlPolicy, MatchPolicy, ShopConfig } from '@radovin/contracts';
import { query, queryOne } from '@radovin/db';
import { Taxonomy, type TaxonomySnapshot } from '@radovin/domain';

const DEFAULT_POLICY: CrawlPolicy = {
  key: 'gentle', userAgent: null, requestsPerSecond: 0.5, maxConcurrency: 2,
  requestTimeoutMs: 20_000, maxRetries: 3, backoffBaseMs: 1000, backoffMaxMs: 60_000,
  respectRobots: true, allowBrowser: false, dailyRequestBudget: null,
};

interface ShopRow {
  id: string; key: string; name: string; base_url: string; canonical_host: string;
  alternate_hosts: string[]; segment: 'wine' | 'spirit' | 'mixed';
  adapter_key: string; adapter_version: string; adapter_config: Record<string, unknown>;
  discovery_strategy: string; policy_disabled: boolean;
  policy_key: string | null; user_agent: string | null;
  requests_per_second: number | null; max_concurrency: number | null;
  request_timeout_ms: number | null; max_retries: number | null;
  backoff_base_ms: number | null; backoff_max_ms: number | null;
  respect_robots: boolean | null; allow_browser: boolean | null;
  daily_request_budget: number | null;
}

const SHOP_SQL = `
  SELECT s.id, s.key, s.name, s.base_url, s.canonical_host, s.alternate_hosts, s.segment,
         s.adapter_key, s.adapter_version, s.adapter_config, s.discovery_strategy, s.policy_disabled,
         cp.key AS policy_key, cp.user_agent, cp.requests_per_second, cp.max_concurrency,
         cp.request_timeout_ms, cp.max_retries, cp.backoff_base_ms, cp.backoff_max_ms,
         cp.respect_robots, cp.allow_browser, cp.daily_request_budget
    FROM shops s
    LEFT JOIN crawl_policies cp ON cp.id = s.crawl_policy_id
`;

function toShopConfig(row: ShopRow): ShopConfig {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    baseUrl: row.base_url,
    canonicalHost: row.canonical_host,
    alternateHosts: row.alternate_hosts ?? [],
    segment: row.segment,
    adapterKey: row.adapter_key,
    adapterVersion: row.adapter_version,
    adapterConfig: row.adapter_config ?? {},
    discoveryStrategy: row.discovery_strategy,
    policyDisabled: row.policy_disabled,
    crawlPolicy: {
      key: row.policy_key ?? DEFAULT_POLICY.key,
      userAgent: row.user_agent,
      requestsPerSecond: row.requests_per_second ?? DEFAULT_POLICY.requestsPerSecond,
      maxConcurrency: row.max_concurrency ?? DEFAULT_POLICY.maxConcurrency,
      requestTimeoutMs: row.request_timeout_ms ?? DEFAULT_POLICY.requestTimeoutMs,
      maxRetries: row.max_retries ?? DEFAULT_POLICY.maxRetries,
      backoffBaseMs: row.backoff_base_ms ?? DEFAULT_POLICY.backoffBaseMs,
      backoffMaxMs: row.backoff_max_ms ?? DEFAULT_POLICY.backoffMaxMs,
      respectRobots: row.respect_robots ?? DEFAULT_POLICY.respectRobots,
      allowBrowser: row.allow_browser ?? DEFAULT_POLICY.allowBrowser,
      dailyRequestBudget: row.daily_request_budget,
    },
  };
}

export async function loadShop(shopId: string): Promise<ShopConfig | null> {
  const row = await queryOne<ShopRow>(`${SHOP_SQL} WHERE s.id = $1`, [shopId]);
  return row ? toShopConfig(row) : null;
}

export async function loadShopByKey(key: string): Promise<ShopConfig | null> {
  const row = await queryOne<ShopRow>(`${SHOP_SQL} WHERE s.key = $1`, [key]);
  return row ? toShopConfig(row) : null;
}

export async function loadActiveShops(): Promise<ShopConfig[]> {
  const rows = await query<ShopRow>(
    `${SHOP_SQL} WHERE s.active AND NOT s.policy_disabled ORDER BY s.sort_order`,
  );
  return rows.map(toShopConfig);
}

// ── Taxonomia cache ─────────────────────────────────────────────────────────

let cache: { at: number; taxonomy: Taxonomy } | null = null;
const TTL_MS = 120_000;

export async function getTaxonomy(force = false): Promise<Taxonomy> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.taxonomy;

  const [brands, producers, categories, aliases, negatives, terms, version] = await Promise.all([
    query<{ id: string; canonical_name: string; name_norm: string; producer_id: string | null; category_id: string | null; fuzzy_blocked: boolean }>(
      `SELECT id, canonical_name, name_norm, producer_id, category_id, fuzzy_blocked
         FROM brands WHERE status = 'active'`),
    query<{ id: string; canonical_name: string; name_norm: string; fuzzy_blocked: boolean }>(
      `SELECT id, canonical_name, name_norm, fuzzy_blocked FROM producers WHERE status = 'active'`),
    query<{ id: string; key: string; name_norm: string; aliases: string[] }>(
      `SELECT c.id, c.key, rv_search_norm(c.name_hu) AS name_norm,
              coalesce(array_agg(ca.alias) FILTER (WHERE ca.alias IS NOT NULL), '{}') AS aliases
         FROM product_categories c
         LEFT JOIN category_aliases ca ON ca.category_id = c.id AND ca.approved
        WHERE c.active GROUP BY c.id, c.key, c.name_hu`),
    query<{ alias_type: string; alias_norm: string; target_kind: string; target_id: string | null; target_literal: string | null; shop_id: string | null; approved: boolean }>(
      `SELECT alias_type, alias_norm, target_kind, target_id, target_literal, shop_id, approved
         FROM aliases WHERE approved AND active`),
    query<{ left_norm: string; right_norm: string; category_key: string | null; reason: string }>(
      `SELECT na.left_norm, na.right_norm, pc.key AS category_key, na.reason
         FROM negative_aliases na LEFT JOIN product_categories pc ON pc.id = na.category_id`),
    query<{ term_norm: string; term_class: string; category_key: string | null }>(
      `SELECT it.term_norm, it.term_class, pc.key AS category_key
         FROM identity_terms it LEFT JOIN product_categories pc ON pc.id = it.category_id
        WHERE it.active`),
    queryOne<{ value: string }>(`SELECT value::text AS value FROM settings WHERE key = 'taxonomy.version' AND active`),
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
    version: (version?.value ?? '"1.0.0"').replace(/"/g, ''),
  };

  const taxonomy = new Taxonomy(snapshot);
  cache = { at: Date.now(), taxonomy };
  return taxonomy;
}

/** Az adapternek atadott feloldofuggvenyek. */
export function resolversFor(taxonomy: Taxonomy) {
  return {
    resolveBrand: (text: string) => {
      const hit = taxonomy.resolveBrand(text);
      return hit ? { id: hit.id, canonicalName: hit.canonicalName, producerId: hit.producerId ?? null } : null;
    },
    resolveProducer: (text: string) => {
      const hit = taxonomy.resolveProducer(text);
      return hit ? { id: hit.id, canonicalName: hit.canonicalName } : null;
    },
    resolveCategory: (text: string) => taxonomy.resolveCategory(text),
  };
}

// ── Beallitasok ─────────────────────────────────────────────────────────────

let settingsCache: { at: number; settings: Map<string, unknown>; flags: Map<string, boolean> } | null = null;

export async function getSettings(force = false) {
  if (!force && settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache;
  const [rows, flagRows] = await Promise.all([
    query<{ key: string; value: unknown }>('SELECT key, value FROM settings WHERE active'),
    query<{ key: string; enabled: boolean }>('SELECT key, enabled FROM feature_flags'),
  ]);
  settingsCache = {
    at: Date.now(),
    settings: new Map(rows.map((r) => [r.key, r.value])),
    flags: new Map(flagRows.map((r) => [r.key, r.enabled])),
  };
  return settingsCache;
}

const DEFAULT_THRESHOLDS: MatchPolicy['thresholds'] = {
  autoMatch: { evidenceCoverage: 0.9, extractionQuality: 0.9, agreementScore: 0.96, topMargin: 0.1 },
  review: { minScore: 0.7 },
  ambiguousMargin: 0.03,
  volumeToleranceMl: 5,
  priceRatioMax: 2.0,
};

export async function getMatchPolicy(): Promise<MatchPolicy> {
  const s = await getSettings();
  // A tarolt sor egy REGEBBI sema szerint keszult, ezert osszefesuljuk az
  // alapertelmezessel. Enelkul egy kesobb bevezetett kuszob `undefined`-kent
  // erkezne, es minden ra epulo osszehasonlitas csendben hamis lenne.
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...((s.settings.get('matching.thresholds') ?? {}) as Partial<MatchPolicy['thresholds']>),
  } as MatchPolicy['thresholds'];
  const weights = (s.settings.get('matching.field_weights') ?? {
    producer: 0.18, expression: 0.28, vintage: 0.16, volume: 0.16,
    category: 0.06, region: 0.06, abv: 0.04, gtin: 0.04, image: 0.02,
  }) as Record<string, number>;
  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v).replace(/"/g, '');
  return {
    matcherVersion: str(s.settings.get('matcher.version'), '2.1.0'),
    taxonomyVersion: str(s.settings.get('taxonomy.version'), '1.0.0'),
    policyVersion: str(s.settings.get('policy.version'), '2.1.0'),
    autoMatchEnabled: s.flags.get('auto_match') ?? false,
    autoMatchIdentifierOnly: s.flags.get('auto_match_identifier_only') ?? true,
    autoMatchIdentityComplete: s.flags.get('auto_match_identity_complete') ?? false,
    thresholds,
    fieldWeights: weights,
  };
}
