/**
 * Integrációs teszt (spec 32.3): a teljes lánc valós Postgres ellen.
 *
 *   listing beírása → klaszterezés → párosítás → review → igazolt kapcsolat
 *   → ártörténet → minőségi kapu → atomikus publikáció
 *
 * Külön bizonyítja azt is, hogy:
 *   · a hibás/megszakadt futás NEM írja felül az utolsó jó publikációt,
 *   · a webshoponkénti egyediségi kulcsok nem duplikálnak ismételt futásnál,
 *   · az identitás-eltolódás blokkolja az ár publikálását.
 *
 * A teszt kihagyja magát, ha nincs TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, execute, initDb, migrate, query, queryOne } from '@radovin/db';
import { emptyIdentityFields, emptyPriceSnapshot, type NormalizedSourceListing } from '@radovin/contracts';
import { contentHash, identityHash, sourceFingerprint } from '@radovin/domain';

const DB_URL = process.env['TEST_DATABASE_URL'];
const run = DB_URL ? describe : describe.skip;

function listing(over: {
  shopKey: string; name: string; url: string; platformId: string;
  priceHuf: number; volumeMl?: number | null; vintage?: number | null;
  packaging?: string; producer?: string; expression?: string;
  gtin?: string | null; quality?: number; producerId?: string | null;
}): NormalizedSourceListing {
  const identity = {
    ...emptyIdentityFields(),
    categoryKey: 'wine',
    // A valos kinyeresi lanc a taxonomian keresztul feloldja a termelot;
    // a fixture ugyanezt teszi, kulonben a `producer` kotelezo mezo
    // bizonyitatlan maradna, es a motor helyesen tartozkodna.
    producerId: over.producerId ?? null,
    producer: over.producer ?? 'Gere Attila',
    expression: over.expression ?? 'roka pinot noir',
    vintageValue: over.vintage === undefined ? 2023 : over.vintage,
    vintageStatus: (over.vintage === null ? 'unknown' : 'vintage') as never,
    volumeMl: over.volumeMl === undefined ? 750 : over.volumeMl,
    packCount: 1,
    packagingType: (over.packaging ?? 'standard') as never,
    gtin: over.gtin ?? null,
  };
  const price = { ...emptyPriceSnapshot() };
  price.currentPriceHuf = over.priceHuf;
  price.regularPriceHuf = over.priceHuf;
  price.selectedComparablePriceHuf = over.priceHuf;
  price.priceType = 'regular';
  price.comparable = true;
  price.inStock = true;
  price.vatIncluded = true;

  return {
    shopKey: over.shopKey,
    canonicalUrl: over.url,
    urlKey: over.url.replace(/^https?:\/\//, '').toLowerCase(),
    finalUrl: over.url,
    platformProductId: over.platformId,
    platformVariantId: null,
    sku: null,
    gtin: over.gtin ?? null,
    rawName: over.name,
    rawBrand: over.producer ?? 'Gere Attila',
    rawCategoryPath: ['Bor', 'Vörösbor'],
    imageUrl: null,
    descriptionExcerpt: null,
    identity,
    price,
    availabilityStatus: 'in_stock',
    evidence: {
      name: {
        field: 'name', normalized_value: over.name, raw_value: over.name,
        source_location: 'test', source_excerpt: over.name,
        method: 'platform_api', confidence: 0.99, observed_at: new Date().toISOString(),
      },
      volumeMl: {
        field: 'volumeMl', normalized_value: identity.volumeMl, raw_value: `${identity.volumeMl} ml`,
        source_location: 'test', source_excerpt: `${identity.volumeMl} ml`,
        method: 'platform_api', confidence: 0.98, observed_at: new Date().toISOString(),
      },
    },
    extractionQuality: over.quality ?? 0.96,
    extractorKey: 'test',
    extractorVersion: '1.0.0',
    extractionMethod: 'platform_api',
    parseWarnings: [],
    contentHash: contentHash({ name: over.name, identity }),
    identityHash: identityHash({ platformProductId: over.platformId, identity }),
    sourceFingerprint: sourceFingerprint(over.name, { volume: identity.volumeMl }),
  };
}

run('teljes pipeline valos adatbazison', () => {
  let shopIds = new Map<string, string>();
  let variantId = '';
  let runId = '';
  let producerId = '';

  beforeAll(async () => {
    initDb({ connectionString: DB_URL!, max: 4, applicationName: 'radovin-e2e' });
    await migrate();

    // Tiszta lap az uzleti tablakon; a referenciaadatok (shops, kategoriak,
    // taxonomia) megmaradnak.
    //
    // FIGYELEM: a shops.last_discovery_run_id -> crawl_runs FK miatt a
    // `TRUNCATE crawl_runs CASCADE` MAGAT A SHOPS TABLAT IS kiuritene, mert a
    // CASCADE a hivatkozo tablakra terjed. Ezert a crawl_runs kulon, DELETE-tel
    // urul, miutan a hivatkozasokat nullaztuk.
    await execute('UPDATE shops SET last_discovery_run_id = NULL');
    await execute(`TRUNCATE market_offers, market_variant_summary, market_publications,
                            price_events, offer_observations, source_listing_snapshots,
                            match_decisions, match_relations, variant_shop_status,
                            rejected_candidates, search_attempts, review_case_events,
                            review_cases, source_listings,
                            canonical_variants, product_families CASCADE`);
    await execute('DELETE FROM job_runs');
    await execute('DELETE FROM crawl_runs');

    const shops = await query<{ id: string; key: string }>(
      `UPDATE shops SET active = true, health_status = 'ok', policy_disabled = false
        WHERE key IN ('bortarsasag','winelovers','radovin') RETURNING id, key`,
    );
    shopIds = new Map(shops.map((s) => [s.key, s.id]));

    const producer = await queryOne<{ id: string }>(
      `INSERT INTO producers (canonical_name, status) VALUES ('Gere Attila','active')
       ON CONFLICT (name_norm) WHERE status <> 'merged'
       DO UPDATE SET canonical_name = EXCLUDED.canonical_name
       RETURNING id`,
    );
    producerId = producer!.id;
  }, 60_000);

  afterAll(async () => { await closeDb(); });

  it('létrehoz egy kanonikus változatot és bejegyzi minden aktív webshopra a keresést', async () => {
    const category = await queryOne<{ id: string; identity_profile: unknown; comparison_policy: unknown }>(
      `SELECT id, identity_profile, comparison_policy FROM product_categories WHERE key = 'wine'`,
    );
    const family = await queryOne<{ id: string }>(
      `INSERT INTO product_families (category_id, producer_id, canonical_name, product_line, status)
       VALUES ($1,$2,'Roka Pinot Noir','roka pinot noir','active') RETURNING id`,
      [category!.id, producerId],
    );
    const variant = await queryOne<{ id: string }>(
      `INSERT INTO canonical_variants
         (product_family_id, canonical_display_name, vintage_value, vintage_status,
          volume_ml, pack_count, packaging_type, identity_profile_json, comparison_policy_json, status)
       VALUES ($1,'Gere Attila Roka Pinot Noir 2023 0,75 l',2023,'vintage',750,1,'standard',$2,$3,'active')
       RETURNING id`,
      [family!.id, JSON.stringify(category!.identity_profile), JSON.stringify(category!.comparison_policy)],
    );
    variantId = variant!.id;

    await execute(
      `INSERT INTO variant_shop_status (canonical_variant_id, shop_id, status, next_search_at)
       SELECT $1, id, 'unsearched', now() FROM shops WHERE active`,
      [variantId],
    );
    const statuses = await query('SELECT * FROM variant_shop_status WHERE canonical_variant_id = $1', [variantId]);
    expect(statuses.length).toBeGreaterThanOrEqual(3);
  });

  it('perzisztálja három webshop listingjét, ismételt futásnál sem duplikál', async () => {
    const { persistListing } = await import('../../apps/worker/src/lib/persist.js');
    const crawlRun = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs (shop_id, run_type, trigger, status, adapter_key, adapter_version)
       VALUES ($1,'discovery','manual','running','test','1.0.0') RETURNING id`,
      [shopIds.get('bortarsasag')],
    );
    runId = crawlRun!.id;

    const fixtures = [
      { shopKey: 'bortarsasag', name: 'Gere Attila Roka Pinot Noir 2023', url: 'https://www.bortarsasag.hu/p/gere-roka-2023', platformId: 'BT-1', priceHuf: 11490 },
      { shopKey: 'winelovers', name: 'Gere Roka Pinot Noir 2023 0,75l', url: 'https://wineloverswebshop.hu/termek/gere-roka-2023', platformId: 'WL-1', priceHuf: 12900 },
      { shopKey: 'radovin', name: 'Gere Attila - Roka Pinot Noir 2023', url: 'https://radovin.hu/termek/gere-roka-pinot-noir-2023', platformId: 'RD-1', priceHuf: 13490 },
    ];

    const wineCategory = await queryOne<{ id: string }>(`SELECT id FROM product_categories WHERE key='wine'`);

    for (const f of fixtures) {
      const result = await persistListing({
        shopId: shopIds.get(f.shopKey)!,
        crawlRunId: runId,
        listing: listing({ ...f, producerId }),
        comparisonPolicy: { allowedPriceTypes: ['regular', 'sale'], requireInStock: false },
        categoryId: wineCategory!.id,
      });
      expect(result.isNew).toBe(true);
    }

    // Az elso futas lezarasa. A crawl_runs_single_discovery_uq reszleges egyedi
    // index szandekosan tiltja, hogy egy shopon ket 'running' discovery legyen
    // egyszerre (spec 19.5), ezert a masodik futas elott lezarjuk az elsot.
    await execute(`UPDATE crawl_runs SET status = 'succeeded', finished_at = now() WHERE id = $1`, [runId]);

    // Ismetelt futas UGYANAZOKKAL az adatokkal: nem keletkezhet uj listing
    const secondRun = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs (shop_id, run_type, trigger, status, adapter_key, adapter_version)
       VALUES ($1,'discovery','manual','running','test','1.0.0') RETURNING id`,
      [shopIds.get('bortarsasag')],
    );
    for (const f of fixtures) {
      const result = await persistListing({
        shopId: shopIds.get(f.shopKey)!,
        crawlRunId: secondRun!.id,
        listing: listing({ ...f, producerId }),
        comparisonPolicy: { allowedPriceTypes: ['regular', 'sale'], requireInStock: false },
        categoryId: wineCategory!.id,
      });
      expect(result.isNew).toBe(false);
    }

    const count = await queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM source_listings`);
    expect(count!.count).toBe(3);
  }, 60_000);

  it('a matcher mindhárom listinget a helyes kanonikus változathoz köti', async () => {
    const { evaluateVariantForShop, VARIANT_QUERY } = await import('../../apps/worker/src/lib/matching.js');
    const { getTaxonomy, getMatchPolicy } = await import('../../apps/worker/src/lib/shop.js');

    const variant = await queryOne(`${VARIANT_QUERY} WHERE cv.id = $1`, [variantId]);
    const taxonomy = await getTaxonomy(true);
    const policy = await getMatchPolicy();
    // A teszt idejere bekapcsoljuk az automatikus parositast, hogy a teljes
    // lanc vegigmenjen; a hard gate ettol fuggetlenul fog.
    policy.autoMatchEnabled = true;
    policy.autoMatchIdentifierOnly = false;

    for (const [key, shopId] of shopIds) {
      const result = await evaluateVariantForShop({
        variant: variant as never, shopId, shopKey: key,
        taxonomy, policy, sourceHealthy: true,
      });
      expect(result.candidateCount).toBeGreaterThan(0);
      expect(['auto_verified', 'needs_review']).toContain(result.decision.status);
    }

    const verified = await query(
      `SELECT * FROM match_relations WHERE canonical_variant_id = $1 AND status = 'verified'`,
      [variantId],
    );
    expect(verified.length).toBe(3);
  }, 90_000);

  it('a magnum változat NEM kap párt a 0,75 l-es listingekhez (hard gate)', async () => {
    const { evaluateVariantForShop, VARIANT_QUERY } = await import('../../apps/worker/src/lib/matching.js');
    const { getTaxonomy, getMatchPolicy } = await import('../../apps/worker/src/lib/shop.js');

    const category = await queryOne<{ id: string; identity_profile: unknown; comparison_policy: unknown }>(
      `SELECT id, identity_profile, comparison_policy FROM product_categories WHERE key='wine'`,
    );
    const family = await queryOne<{ id: string }>(
      `SELECT id FROM product_families WHERE canonical_name = 'Roka Pinot Noir' LIMIT 1`,
    );
    const magnum = await queryOne<{ id: string }>(
      `INSERT INTO canonical_variants
         (product_family_id, canonical_display_name, vintage_value, vintage_status,
          volume_ml, pack_count, packaging_type, identity_profile_json, comparison_policy_json, status)
       VALUES ($1,'Gere Attila Roka Pinot Noir 2023 Magnum 1,5 l',2023,'vintage',1500,1,'standard',$2,$3,'active')
       RETURNING id`,
      [family!.id, JSON.stringify(category!.identity_profile), JSON.stringify(category!.comparison_policy)],
    );

    const variant = await queryOne(`${VARIANT_QUERY} WHERE cv.id = $1`, [magnum!.id]);
    const taxonomy = await getTaxonomy();
    const policy = await getMatchPolicy();
    policy.autoMatchEnabled = true;

    const result = await evaluateVariantForShop({
      variant: variant as never,
      shopId: shopIds.get('bortarsasag')!, shopKey: 'bortarsasag',
      taxonomy, policy, sourceHealthy: true,
    });

    // A 0,75 l-es listing jelöltként előjön, de kiszerelés-ellentmondás miatt kiesik
    expect(result.decision.status).not.toBe('auto_verified');
    const rejected = await query(
      `SELECT * FROM rejected_candidates WHERE canonical_variant_id = $1`, [magnum!.id],
    );
    expect(
      result.decision.status === 'rejected' || rejected.length > 0 ||
      result.decision.status === 'not_found_after_full_search',
    ).toBe(true);
  }, 60_000);

  it('publikálja a piaci pillanatképet, helyes ranggal és mediánnal', async () => {
    const { rebuildAndPublish } = await import('../../apps/worker/src/lib/publish.js');
    const result = await rebuildAndPublish({
      freshnessMaxHours: 240, matcherVersion: '2.1.0',
    });

    expect(result.published).toBe(true);
    expect(result.gate.passed).toBe(true);
    expect(result.offersTotal).toBe(3);

    const summary = await queryOne<{
      min_price_huf: number; median_price_huf: number; max_price_huf: number;
      shop_count: number; spread_pct: number;
    }>(
      `SELECT ms.* FROM market_variant_summary ms
         JOIN v_current_publication p ON p.id = ms.publication_id
        WHERE ms.canonical_variant_id = $1`,
      [variantId],
    );
    expect(summary!.min_price_huf).toBe(11490);
    expect(summary!.median_price_huf).toBe(12900);
    expect(summary!.max_price_huf).toBe(13490);
    expect(summary!.shop_count).toBe(3);

    const ranks = await query<{ shop_key: string; rank_in_market: number; rank_denominator: number }>(
      `SELECT shop_key, rank_in_market, rank_denominator FROM v_market_offers
        WHERE canonical_variant_id = $1 ORDER BY rank_in_market`,
      [variantId],
    );
    expect(ranks.map((r) => r.shop_key)).toEqual(['bortarsasag', 'winelovers', 'radovin']);
    expect(ranks.every((r) => r.rank_denominator === 3)).toBe(true);
  }, 60_000);

  it('árváltozásnál eseményt ír és frissíti a publikációt', async () => {
    const { persistListing } = await import('../../apps/worker/src/lib/persist.js');
    const { rebuildAndPublish } = await import('../../apps/worker/src/lib/publish.js');
    const wineCategory = await queryOne<{ id: string }>(`SELECT id FROM product_categories WHERE key='wine'`);

    const newRun = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs (shop_id, run_type, trigger, status, adapter_key, adapter_version)
       VALUES ($1,'price_refresh','manual','running','test','1.0.0') RETURNING id`,
      [shopIds.get('bortarsasag')],
    );

    const result = await persistListing({
      shopId: shopIds.get('bortarsasag')!,
      crawlRunId: newRun!.id,
      listing: listing({
        shopKey: 'bortarsasag', name: 'Gere Attila Roka Pinot Noir 2023',
        url: 'https://www.bortarsasag.hu/p/gere-roka-2023', platformId: 'BT-1',
        priceHuf: 10990, producerId,
      }),
      comparisonPolicy: { allowedPriceTypes: ['regular', 'sale'], requireInStock: false },
      categoryId: wineCategory!.id,
    });
    expect(result.priceChanged).toBe(true);

    const events = await query<{ event_type: string; delta_huf: number; new_price_huf: number }>(
      `SELECT event_type, delta_huf, new_price_huf FROM price_events
        WHERE event_type = 'price_changed' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(events[0]?.new_price_huf).toBe(10990);
    expect(events[0]?.delta_huf).toBe(-500);

    const publication = await rebuildAndPublish({ freshnessMaxHours: 240, matcherVersion: '2.1.0' });
    expect(publication.published).toBe(true);

    const min = await queryOne<{ min_price_huf: number }>(
      `SELECT ms.min_price_huf FROM market_variant_summary ms
         JOIN v_current_publication p ON p.id = ms.publication_id
        WHERE ms.canonical_variant_id = $1`,
      [variantId],
    );
    expect(min!.min_price_huf).toBe(10990);
  }, 60_000);

  it('identitás-eltolódásnál blokkolja az ár publikálását és review-t nyit', async () => {
    const { persistListing } = await import('../../apps/worker/src/lib/persist.js');
    const wineCategory = await queryOne<{ id: string }>(`SELECT id FROM product_categories WHERE key='wine'`);

    const driftRun = await queryOne<{ id: string }>(
      `INSERT INTO crawl_runs (shop_id, run_type, trigger, status, adapter_key, adapter_version)
       VALUES ($1,'price_refresh','manual','running','test','1.0.0') RETURNING id`,
      [shopIds.get('winelovers')],
    );

    // UGYANAZ az URL/platform ID, de MÁS évjárat -> a webshop lecserélte a terméket
    const result = await persistListing({
      shopId: shopIds.get('winelovers')!,
      crawlRunId: driftRun!.id,
      listing: listing({
        shopKey: 'winelovers', name: 'Gere Roka Pinot Noir 2024 0,75l',
        url: 'https://wineloverswebshop.hu/termek/gere-roka-2023', platformId: 'WL-1',
        priceHuf: 13900, vintage: 2024, producerId,
      }),
      comparisonPolicy: { allowedPriceTypes: ['regular', 'sale'], requireInStock: false },
      categoryId: wineCategory!.id,
    });

    expect(result.driftSeverity).toBe('significant');
    expect(result.quarantined).toBe(true);

    // A kapcsolat 'drifted', az ar NEM osszehasonlithato
    const relation = await queryOne<{ status: string; drift_reason: string }>(
      `SELECT mr.status, mr.drift_reason FROM match_relations mr
         JOIN source_listings sl ON sl.id = mr.source_listing_id
        WHERE sl.platform_product_id = 'WL-1'`,
    );
    expect(relation!.status).toBe('drifted');

    const offer = await queryOne<{ comparable: boolean; selected_comparable_price_huf: number | null }>(
      `SELECT o.comparable, o.selected_comparable_price_huf
         FROM offer_observations o
         JOIN source_listings sl ON sl.id = o.listing_id
        WHERE sl.platform_product_id = 'WL-1' ORDER BY o.observed_at DESC LIMIT 1`,
    );
    expect(offer!.comparable).toBe(false);
    expect(offer!.selected_comparable_price_huf).toBeNull();

    const review = await queryOne<{ case_type: string }>(
      `SELECT case_type FROM review_cases WHERE case_type = 'mapping_drift' LIMIT 1`,
    );
    expect(review?.case_type).toBe('mapping_drift');
  }, 60_000);

  it('a driftelt forrás ára kiesik a publikációból, a többi megmarad', async () => {
    const { rebuildAndPublish } = await import('../../apps/worker/src/lib/publish.js');
    const result = await rebuildAndPublish({ freshnessMaxHours: 240, matcherVersion: '2.1.0' });
    expect(result.published).toBe(true);

    const offers = await query<{ shop_key: string }>(
      `SELECT shop_key FROM v_market_offers WHERE canonical_variant_id = $1`, [variantId],
    );
    // A winelovers driftelt -> kiesik; a masik ketto marad
    expect(offers.map((o) => o.shop_key).sort()).toEqual(['bortarsasag', 'radovin']);
  }, 60_000);

  it('a megbukott minőségi kapu NEM írja felül az utolsó jó publikációt', async () => {
    const good = await queryOne<{ id: string; generation: number; offers_total: number }>(
      `SELECT id, generation, offers_total FROM v_current_publication`,
    );
    expect(good).not.toBeNull();

    // Mesterségesen elrontott generáció: duplikált (termék × webshop) ajánlat
    const bad = await queryOne<{ id: string }>(
      `INSERT INTO market_publications (generation, status, matcher_version)
       VALUES ($1, 'building', '2.1.0') RETURNING id`,
      [Date.now() + 1],
    );
    await execute(
      `INSERT INTO market_offers
         (publication_id, canonical_variant_id, shop_id, source_listing_id, price_huf,
          price_type, match_status, decision_origin, observed_at, product_url)
       SELECT $1, mo.canonical_variant_id, mo.shop_id, mo.source_listing_id, mo.price_huf,
              mo.price_type, mo.match_status, mo.decision_origin, mo.observed_at, mo.product_url
         FROM market_offers mo WHERE mo.publication_id = $2`,
      [bad!.id, good!.id],
    );
    await execute(`UPDATE market_publications SET status = 'quarantined' WHERE id = $1`, [bad!.id]);

    // Az aktualis publikalt generacio valtozatlan
    const current = await queryOne<{ id: string; offers_total: number }>(
      `SELECT id, offers_total FROM v_current_publication`,
    );
    expect(current!.id).toBe(good!.id);
    expect(current!.offers_total).toBe(good!.offers_total);
  }, 60_000);
});
