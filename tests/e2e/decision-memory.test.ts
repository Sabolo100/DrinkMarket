/**
 * A dontesi naplo es a sopres hurka (0024) - valos Postgres ellen.
 *
 * 2026 szeptembereben a `match_decisions` 22 nap alatt 38 GB lett: a sopres
 * percenkent ugyanazt a ~300 listinget ertekelte ujra, es mindegyik ujra
 * irta ugyanazt a dontest. Ez a fajl azt bizonyitja, hogy
 *   · azonos dontes nem ir uj sort, csak a meglevot erositi meg,
 *   · egy listing kiertekelese nem irja felul egy MASIK listinggel mar
 *     igazolt par allapotat,
 *   · a varakoztatott listing kiesik a sopres halmazabol,
 *   · a retencio csak a felulirt, senki altal nem hivatkozott gepi sort torli.
 *
 * A teszt kihagyja magat, ha nincs TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, execute, initDb, migrate, query, queryOne } from '@radovin/db';
import type { MatchDecisionResult, MatchStatus } from '@radovin/contracts';

const DB_URL = process.env['TEST_DATABASE_URL'];
const run = DB_URL ? describe : describe.skip;

const POLICY = { matcherVersion: 'm-test', taxonomyVersion: 't-test', policyVersion: 'p-test' };

function decisionFor(opts: {
  variantId: string; shopId: string; listingId: string | null;
  status: MatchStatus; strength?: number;
}): MatchDecisionResult {
  return {
    canonicalVariantId: opts.variantId,
    sourceListingId: opts.listingId,
    shopId: opts.shopId,
    status: opts.status,
    ...POLICY,
    hardContradictions: [],
    fieldResults: {},
    agreementScore: 0.7,
    evidenceCoverage: 0.8,
    extractionQuality: 0.9,
    retrievalSupport: 0.5,
    topMargin: 0.1,
    decisionStrength: opts.strength ?? 0.6,
    contradictionCount: 0,
    negativeHistory: 0,
    reasonCodes: ['TEST_REASON'],
    explanationHu: 'teszt dontes',
    candidateSources: [],
    runnerUp: [],
    decidedBy: 'engine',
  };
}

run('dontesi naplo es sopres (0024)', () => {
  let shopId = '';
  let variantId = '';
  const listing: Record<string, string> = {};

  beforeAll(async () => {
    initDb({ connectionString: DB_URL!, max: 4, applicationName: 'radovin-e2e-decisions' });
    await migrate();

    await execute('UPDATE shops SET last_discovery_run_id = NULL');
    await execute(`TRUNCATE market_offers, market_variant_summary, market_publications,
                            price_events, offer_observations, source_listing_snapshots,
                            match_decisions, match_relations, variant_shop_status,
                            rejected_candidates, search_attempts, review_case_events,
                            review_cases, source_listings,
                            canonical_variants, product_families CASCADE`);

    const shop = await queryOne<{ id: string }>(
      `UPDATE shops SET active = true, policy_disabled = false WHERE key = 'radovin' RETURNING id`,
    );
    shopId = shop!.id;

    const category = await queryOne<{ id: string }>(`SELECT id FROM product_categories WHERE key = 'wine'`);
    const family = await queryOne<{ id: string }>(
      `INSERT INTO product_families (category_id, canonical_name, status)
       VALUES ($1, 'Hurok Teszt Bor', 'active') RETURNING id`,
      [category!.id],
    );
    const variant = await queryOne<{ id: string }>(
      `INSERT INTO canonical_variants
         (product_family_id, canonical_display_name, vintage_status, volume_ml, pack_count,
          packaging_type, status)
       VALUES ($1, 'Hurok Teszt Bor 0,75 l', 'unknown', 750, 1, 'standard', 'active')
       RETURNING id`,
      [family!.id],
    );
    variantId = variant!.id;

    for (const key of ['A', 'B', 'C', 'D']) {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO source_listings (shop_id, canonical_url, url_key, raw_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [shopId, `https://radovin.hu/teszt-${key}`, `radovin.hu/teszt-${key}`, `Hurok Teszt Bor ${key}`],
      );
      listing[key] = row!.id;
    }
  }, 60_000);

  afterAll(async () => { await closeDb(); });

  async function persist(decision: MatchDecisionResult, origin: 'search' | 'cluster') {
    const { persistDecision } = await import('../../apps/worker/src/lib/matching.js');
    return persistDecision({
      decision,
      variant: { id: variantId, canonical_display_name: 'Hurok Teszt Bor 0,75 l' } as never,
      shopId, shopKey: 'radovin',
      policy: POLICY as never,
      crawlRunId: null,
      candidates: decision.sourceListingId
        ? [{ listingId: decision.sourceListingId, channels: [{ channel: 'catalog_block', rank: 1, score: 0.8 }] } as never]
        : [],
      origin,
    });
  }

  it('azonos dontes nem ir uj sort, a meglevot erositi meg', async () => {
    const d = decisionFor({ variantId, shopId, listingId: listing['A']!, status: 'needs_review' });
    await persist(d, 'cluster');
    await persist(d, 'cluster');
    await persist(d, 'cluster');

    const rows = await query<{ seen_count: number; last_seen_at: Date | null }>(
      `SELECT seen_count, last_seen_at FROM match_decisions
        WHERE canonical_variant_id = $1 AND source_listing_id = $2`,
      [variantId, listing['A']],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seen_count).toBe(3);
    expect(rows[0]!.last_seen_at).not.toBeNull();

    // A nyitott eset a meglevo dontesre mutat, nem egy ujabb masolatra.
    const rc = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM review_cases rc
         JOIN match_decisions md ON md.id = rc.match_decision_id
        WHERE rc.canonical_variant_id = $1 AND rc.status = 'open'`,
      [variantId],
    );
    expect(rc!.n).toBe(1);
  });

  it('mas eredmeny uj sort kap', async () => {
    const d = decisionFor({ variantId, shopId, listingId: listing['A']!, status: 'needs_review', strength: 0.61 });
    await persist(d, 'cluster');
    const n = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM match_decisions WHERE canonical_variant_id = $1 AND source_listing_id = $2`,
      [variantId, listing['A']],
    );
    expect(n!.n).toBe(2);
  });

  it('masik listing kiertekelese nem irja felul az igazolt par allapotat', async () => {
    // Lezarjuk az elozo tesztek nyitott esetet, hogy ne zavarja az igazolast.
    await execute(`UPDATE review_cases SET status = 'dismissed' WHERE canonical_variant_id = $1`, [variantId]);
    await execute(
      `INSERT INTO match_relations (canonical_variant_id, source_listing_id, shop_id, status, decision_origin, verified_kind)
       VALUES ($1, $2, $3, 'verified', 'auto', 'auto_verified')`,
      [variantId, listing['B'], shopId],
    );
    await execute(
      `INSERT INTO variant_shop_status (canonical_variant_id, shop_id, status, matched_listing_id)
       VALUES ($1, $2, 'auto_verified', $3)
       ON CONFLICT (canonical_variant_id, shop_id)
       DO UPDATE SET status = 'auto_verified', matched_listing_id = EXCLUDED.matched_listing_id`,
      [variantId, shopId, listing['B']],
    );

    await persist(decisionFor({ variantId, shopId, listingId: listing['C']!, status: 'needs_review' }), 'cluster');
    await persist(decisionFor({ variantId, shopId, listingId: listing['C']!, status: 'insufficient_evidence' }), 'cluster');

    const vss = await queryOne<{ status: string; matched_listing_id: string | null }>(
      `SELECT status, matched_listing_id FROM variant_shop_status WHERE canonical_variant_id = $1 AND shop_id = $2`,
      [variantId, shopId],
    );
    expect(vss!.status).toBe('auto_verified');
    expect(vss!.matched_listing_id).toBe(listing['B']);

    // Igazolt parra nem nyilik eset (a korabbi viselkedes, valtozatlan).
    const open = await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM review_cases WHERE canonical_variant_id = $1 AND status = 'open'`,
      [variantId],
    );
    expect(open!.n).toBe(0);
  });

  it('a varakoztatott listing kiesik a sopres halmazabol, lejarta utan visszakerul', async () => {
    const inBacklog = async () => (await queryOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM cluster_sweep_backlog WHERE id = $1`, [listing['D']],
    ))!.n;

    await execute(`UPDATE source_listings SET cluster_status = 'unclustered', cluster_retry_at = NULL WHERE id = $1`, [listing['D']]);
    expect(await inBacklog()).toBe(1);

    await execute(`UPDATE source_listings SET cluster_retry_at = now() + interval '7 days' WHERE id = $1`, [listing['D']]);
    expect(await inBacklog()).toBe(0);

    await execute(`UPDATE source_listings SET cluster_retry_at = now() - interval '1 minute' WHERE id = $1`, [listing['D']]);
    expect(await inBacklog()).toBe(1);
  });

  it('a retencio csak a felulirt, hivatkozatlan gepi sort torli', async () => {
    const { pruneSupersededDecisions } = await import('../../apps/worker/src/processors/refresh.js');
    await execute('TRUNCATE review_case_events, review_cases, match_decisions CASCADE');

    const insert = async (listingId: string, daysAgo: number, decidedBy = 'engine'): Promise<string> =>
      (await queryOne<{ id: string }>(
        `INSERT INTO match_decisions
           (canonical_variant_id, source_listing_id, shop_id, status, matcher_version,
            taxonomy_version, policy_version, decided_by, created_at)
         VALUES ($1, $2, $3, 'needs_review', 'm', 't', 'p', $4, now() - ($5 || ' days')::interval)
         RETURNING id`,
        [variantId, listingId, shopId, decidedBy, String(daysAgo)],
      ))!.id;

    const regi1 = await insert(listing['A']!, 200);
    const regi2 = await insert(listing['A']!, 190);
    const friss = await insert(listing['A']!, 1);
    const emberi = await insert(listing['C']!, 250, 'human');
    const hivatkozott = await insert(listing['C']!, 240);
    await insert(listing['C']!, 2);
    const egyetlen = await insert(listing['D']!, 300);

    await execute(
      `INSERT INTO review_cases (case_type, canonical_variant_id, source_listing_id, shop_id, match_decision_id, title)
       VALUES ('new_match', $1, $2, $3, $4, 'hivatkozott')`,
      [variantId, listing['C'], shopId, hivatkozott],
    );

    const removed = await pruneSupersededDecisions(180);
    expect(removed).toBe(2);

    const left = new Set((await query<{ id: string }>('SELECT id FROM match_decisions')).map((r) => r.id));
    expect(left.has(regi1)).toBe(false);
    expect(left.has(regi2)).toBe(false);
    expect(left.has(friss)).toBe(true);
    expect(left.has(emberi)).toBe(true);
    expect(left.has(hivatkozott)).toBe(true);
    expect(left.has(egyetlen)).toBe(true);
  });
});
