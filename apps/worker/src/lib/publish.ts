/**
 * Quality gate es atomikus publikacio (spec 31., 19.4).
 *
 * ALAPSZABALY: megszakadt vagy hibas futas NEM irhatja felul az utolso jo
 * eredmenyt. Az uj aggregatum kulon generacioba epul, es csak sikeres
 * quality gate utan valik lathatova - egyetlen tranzakcioban.
 */
import { execute, query, queryOne, transaction } from '@radovin/db';
import { computeMarketPosition, freshnessHours, medianOf } from '@radovin/domain';
import { logger, metrics } from '@radovin/observability';

export interface ShopGateResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  reason: string | null;
}

export interface ShopGateInput {
  shopId: string;
  crawlRunId: string;
  catalogSizeBefore: number | null;
  catalogSizeAfter: number;
  completeness: 'complete' | 'partial' | 'unknown';
  extractOk: number;
  extractFailed: number;
  maxCatalogDropPct: number;
  minParserSuccessRate: number;
  expectedCatalogMin: number | null;
  expectedCatalogMax: number | null;
}

/**
 * Webshoponkenti quality gate (spec 31.1).
 * Ha megbukik, CSAK ennek a webshopnak az uj snapshotja kerul karantenba -
 * a tobbi webshop adata publikalhato marad.
 */
export async function runShopQualityGate(input: ShopGateInput): Promise<ShopGateResult> {
  const checks: ShopGateResult['checks'] = [];

  // 1. Teljesseg
  const completeOk = input.completeness !== 'unknown';
  checks.push({
    name: 'completeness',
    passed: completeOk,
    detail: `A discovery teljessege: ${input.completeness}`,
  });

  // 2. Duplikalt platformtermek/URL kulcs
  const duplicates = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
       SELECT platform_product_id, coalesce(platform_variant_id,'') AS v
         FROM source_listings
        WHERE shop_id = $1 AND platform_product_id IS NOT NULL AND listing_status = 'active'
        GROUP BY 1,2 HAVING count(*) > 1
     ) d`,
    [input.shopId],
  );
  checks.push({
    name: 'no_duplicate_platform_ids',
    passed: (duplicates?.count ?? 0) === 0,
    detail: `${duplicates?.count ?? 0} duplikalt platformazonosito`,
  });

  // 3. Minden matched ar pozitiv HUF es van bizonyiteka
  const badPrices = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM offer_observations o
       JOIN source_listings sl ON sl.id = o.listing_id
      WHERE sl.shop_id = $1 AND o.crawl_run_id = $2
        AND o.comparable
        AND (o.selected_comparable_price_huf IS NULL
             OR o.selected_comparable_price_huf <= 0
             OR o.evidence = '{}'::jsonb)`,
    [input.shopId, input.crawlRunId],
  );
  checks.push({
    name: 'valid_prices',
    passed: (badPrices?.count ?? 0) === 0,
    detail: `${badPrices?.count ?? 0} ervenytelen vagy bizonyitek nelkuli ar`,
  });

  // 4. Idobelyegek a futas ablakaban
  const outOfWindow = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM offer_observations o
       JOIN crawl_runs r ON r.id = o.crawl_run_id
      WHERE o.crawl_run_id = $1
        AND (o.observed_at < r.started_at - interval '5 minutes'
             OR o.observed_at > coalesce(r.finished_at, now()) + interval '5 minutes')`,
    [input.crawlRunId],
  );
  checks.push({
    name: 'timestamps_in_window',
    passed: (outOfWindow?.count ?? 0) === 0,
    detail: `${outOfWindow?.count ?? 0} futasablakon kivuli idobelyeg`,
  });

  // 5. Katalogusmeret-valtozas
  let catalogOk = true;
  let catalogDetail = 'Nincs korabbi baseline.';
  if (input.catalogSizeBefore && input.catalogSizeBefore > 0) {
    const dropPct = ((input.catalogSizeBefore - input.catalogSizeAfter) / input.catalogSizeBefore) * 100;
    catalogOk = dropPct <= input.maxCatalogDropPct;
    catalogDetail = `${input.catalogSizeBefore} -> ${input.catalogSizeAfter} (${dropPct.toFixed(1)}% valtozas, hatar: ${input.maxCatalogDropPct}%)`;
  }
  if (input.expectedCatalogMin && input.catalogSizeAfter < input.expectedCatalogMin) {
    catalogOk = false;
    catalogDetail += ` | A varhato minimum (${input.expectedCatalogMin}) alatt.`;
  }
  checks.push({ name: 'catalog_size', passed: catalogOk, detail: catalogDetail });

  // 6. Parser sikeressegi arany
  const totalExtract = input.extractOk + input.extractFailed;
  const successRate = totalExtract > 0 ? input.extractOk / totalExtract : 1;
  checks.push({
    name: 'parser_success_rate',
    passed: successRate >= input.minParserSuccessRate,
    detail: `${(successRate * 100).toFixed(1)}% (hatar: ${(input.minParserSuccessRate * 100).toFixed(0)}%)`,
  });

  // 7. Megoldatlan kritikus identitas-drift
  const drifted = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM match_relations
      WHERE shop_id = $1 AND status = 'drifted' AND valid_to IS NULL
        AND drift_detected_at > now() - interval '1 day'`,
    [input.shopId],
  );
  checks.push({
    name: 'no_unresolved_drift',
    passed: (drifted?.count ?? 0) < 50,
    detail: `${drifted?.count ?? 0} megoldatlan identitas-drift az elmult napban`,
  });

  const failed = checks.filter((c) => !c.passed);
  const passed = failed.length === 0;

  return {
    passed,
    checks,
    reason: passed ? null : failed.map((c) => `${c.name}: ${c.detail}`).join('; '),
  };
}

export interface PublicationResult {
  publicationId: string | null;
  generation: number;
  published: boolean;
  variantsTotal: number;
  offersTotal: number;
  shopsIncluded: number;
  staleShops: string[];
  gate: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> };
  reason: string | null;
}

export interface PublishOptions {
  freshnessMaxHours: number;
  matcherVersion: string;
  correlationId?: string;
  /** Ha true, a gate hibaja ellenere sem publikalunk (mindig ez az alapertelmezes). */
  dryRun?: boolean;
}

/**
 * A teljes piaci aggregatum ujraepitese es atomikus publikalasa (spec 31.2).
 *
 * 1. Uj generacio letrehozasa 'building' allapotban.
 * 2. Ajanlatok es osszegzesek beszurasa AZ UJ generacioba.
 * 3. Globalis quality gate.
 * 4. Siker eseten: egyetlen tranzakcioban a regi 'published' -> 'superseded',
 *    az uj -> 'published'. Hiba eseten: 'quarantined', a regi valtozatlan.
 */
export async function rebuildAndPublish(opts: PublishOptions): Promise<PublicationResult> {
  const started = Date.now();
  const generation = Date.now();

  const publication = await queryOne<{ id: string }>(
    `INSERT INTO market_publications (generation, status, matcher_version, correlation_id)
     VALUES ($1, 'building', $2, $3) RETURNING id`,
    [generation, opts.matcherVersion, opts.correlationId ?? null],
  );
  const publicationId = publication!.id;

  try {
    // ── 1. Ajanlatok osszegyujtese ────────────────────────────────────────
    // Webshoponkent LEGFELJEBB EGY ajanlat: a legfrissebb, osszehasonlithato,
    // nem karantenozott megfigyeles egy igazolt kapcsolatu listingrol.
    interface OfferRow {
      canonical_variant_id: string;
      shop_id: string;
      source_listing_id: string;
      observation_id: string;
      price_huf: number;
      regular_price_huf: number | null;
      price_type: string;
      in_stock: boolean | null;
      availability_status: string | null;
      match_status: string;
      match_confidence: number | null;
      decision_origin: string;
      observed_at: Date;
      last_checked_at: Date | null;
      product_url: string;
    }

    const offers = await query<OfferRow>(
      `SELECT DISTINCT ON (mr.canonical_variant_id, mr.shop_id)
              mr.canonical_variant_id, mr.shop_id, sl.id AS source_listing_id,
              o.id AS observation_id,
              o.selected_comparable_price_huf AS price_huf,
              o.regular_price_huf, o.price_type, o.in_stock, o.availability_status,
              mr.status AS match_status, mr.confidence AS match_confidence,
              mr.decision_origin, o.observed_at, sl.last_checked_at,
              sl.canonical_url AS product_url
         FROM match_relations mr
         JOIN source_listings sl ON sl.id = mr.source_listing_id
         JOIN shops s ON s.id = mr.shop_id
         JOIN offer_observations o ON o.id = sl.latest_offer_id
         JOIN canonical_variants cv ON cv.id = mr.canonical_variant_id
        WHERE mr.status = 'verified'
          AND mr.valid_to IS NULL
          AND sl.listing_status = 'active'
          AND s.active
          AND cv.status IN ('active','proposed')
          AND o.comparable
          AND NOT o.quarantined
          AND o.selected_comparable_price_huf > 0
        ORDER BY mr.canonical_variant_id, mr.shop_id, o.observed_at DESC`,
    );

    // ── 2. Csoportositas es piaci pozicio szamitasa ──────────────────────
    const byVariant = new Map<string, OfferRow[]>();
    for (const offer of offers) {
      const list = byVariant.get(offer.canonical_variant_id) ?? [];
      list.push(offer);
      byVariant.set(offer.canonical_variant_id, list);
    }

    const now = new Date();
    const staleShops = new Set<string>();
    let offersTotal = 0;

    const offerValues: unknown[] = [];
    const offerRows: string[] = [];
    const summaryValues: unknown[] = [];
    const summaryRows: string[] = [];

    for (const [variantId, variantOffers] of byVariant) {
      const positioned = variantOffers.map((o) => ({
        shopId: o.shop_id,
        listingId: o.source_listing_id,
        priceHuf: o.price_huf,
        observedAt: new Date(o.observed_at),
        inStock: o.in_stock,
        matchStatus: o.match_status,
        stale: freshnessHours(new Date(o.observed_at), now) > opts.freshnessMaxHours,
      }));
      for (const p of positioned) if (p.stale) staleShops.add(p.shopId);

      const market = computeMarketPosition(positioned);
      const prices = positioned.filter((p) => !p.stale).map((p) => p.priceHuf).sort((a, b) => a - b);
      const median = prices.length ? medianOf(prices) : null;

      for (const offer of variantOffers) {
        const rank = market.ranks.get(offer.shop_id);
        const stale = freshnessHours(new Date(offer.observed_at), now) > opts.freshnessMaxHours;
        const base = offerValues.length;
        offerValues.push(
          publicationId, variantId, offer.shop_id, offer.source_listing_id, offer.observation_id,
          offer.price_huf, offer.regular_price_huf, offer.price_type,
          offer.regular_price_huf !== null && offer.regular_price_huf > offer.price_huf,
          offer.in_stock, offer.availability_status, offer.match_status, offer.match_confidence,
          offer.decision_origin, offer.observed_at, offer.last_checked_at,
          freshnessHours(new Date(offer.observed_at), now), stale,
          rank?.rank ?? null, rank?.denominator ?? null, rank?.tied ?? false,
          rank?.deltaToMinHuf ?? null, rank?.deltaToMinPct ?? null,
          rank?.deltaToMedianHuf ?? null, rank?.deltaToMedianPct ?? null,
          offer.product_url,
        );
        offerRows.push(`(${Array.from({ length: 26 }, (_, i) => `$${base + i + 1}`).join(',')})`);
        offersTotal++;
      }

      const sbase = summaryValues.length;
      summaryValues.push(
        publicationId, variantId, market.offerCount, market.shopCount,
        market.minPriceHuf, market.maxPriceHuf, median, market.avgPriceHuf,
        market.spreadHuf, market.spreadPct, market.minShopId, market.maxShopId,
        variantOffers.some((o) => o.regular_price_huf !== null && o.regular_price_huf > o.price_huf),
        positioned.some((p) => p.stale),
        market.offerCount === 0 ? 'degraded'
          : positioned.some((p) => p.stale) ? 'partial'
            : market.shopCount === 1 ? 'provisional' : 'ok',
      );
      summaryRows.push(`(${Array.from({ length: 15 }, (_, i) => `$${sbase + i + 1}`).join(',')})`);
    }

    // ── 3. Beszuras kotegelve ────────────────────────────────────────────
    await insertChunked(
      `INSERT INTO market_offers
         (publication_id, canonical_variant_id, shop_id, source_listing_id, observation_id,
          price_huf, regular_price_huf, price_type, on_sale, in_stock, availability_status,
          match_status, match_confidence, decision_origin, observed_at, last_checked_at,
          freshness_hours, stale, rank_in_market, rank_denominator, tied,
          delta_to_min_huf, delta_to_min_pct, delta_to_median_huf, delta_to_median_pct,
          product_url)
       VALUES `,
      offerRows, offerValues, 26,
    );

    await insertChunked(
      `INSERT INTO market_variant_summary
         (publication_id, canonical_variant_id, offer_count, shop_count,
          min_price_huf, max_price_huf, median_price_huf, avg_price_huf,
          spread_huf, spread_pct, min_shop_id, max_shop_id, any_on_sale, any_stale, data_quality)
       VALUES `,
      summaryRows, summaryValues, 15,
    );

    // ── 4. Globalis quality gate (spec 31.2) ─────────────────────────────
    const gateChecks: PublicationResult['gate']['checks'] = [];

    const dupOffers = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT canonical_variant_id, shop_id FROM market_offers
          WHERE publication_id = $1 GROUP BY 1,2 HAVING count(*) > 1) d`,
      [publicationId],
    );
    gateChecks.push({
      name: 'no_duplicate_variant_shop_offer',
      passed: (dupOffers?.count ?? 0) === 0,
      detail: `${dupOffers?.count ?? 0} duplikalt (termek x webshop) ajanlat`,
    });

    const badDenominator = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT mo.canonical_variant_id,
                count(*) FILTER (WHERE NOT mo.stale) AS valid_count,
                max(mo.rank_denominator) AS denominator
           FROM market_offers mo
          WHERE mo.publication_id = $1
          GROUP BY mo.canonical_variant_id
         HAVING count(*) FILTER (WHERE NOT mo.stale) <> coalesce(max(mo.rank_denominator), 0)
            AND count(*) FILTER (WHERE NOT mo.stale) > 0) d`,
      [publicationId],
    );
    gateChecks.push({
      name: 'rank_denominator_matches_valid_offers',
      passed: (badDenominator?.count ?? 0) === 0,
      detail: `${badDenominator?.count ?? 0} termeknel a rang nevezoje nem egyezik a valid ajanlatok szamaval`,
    });

    const quarantinedShops = await query<{ key: string; name: string }>(
      `SELECT DISTINCT s.key, s.name
         FROM crawl_runs r JOIN shops s ON s.id = r.shop_id
        WHERE r.status = 'quarantined' AND r.started_at > now() - interval '2 days'`,
    );
    // Karantenozott forras adata NEM jelenhet meg frissként: ezeket stale-nek jeloljuk
    if (quarantinedShops.length) {
      await execute(
        `UPDATE market_offers SET stale = true
          WHERE publication_id = $1
            AND shop_id IN (SELECT id FROM shops WHERE key = ANY($2::text[]))`,
        [publicationId, quarantinedShops.map((s) => s.key)],
      );
    }
    gateChecks.push({
      name: 'no_quarantined_shop_shown_fresh',
      passed: true,
      detail: quarantinedShops.length
        ? `${quarantinedShops.length} karantenozott forras stale-kent jelolve: ${quarantinedShops.map((s) => s.name).join(', ')}`
        : 'Nincs karantenozott forras',
    });

    const negativePrices = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM market_offers
        WHERE publication_id = $1 AND price_huf <= 0`,
      [publicationId],
    );
    gateChecks.push({
      name: 'all_prices_positive',
      passed: (negativePrices?.count ?? 0) === 0,
      detail: `${negativePrices?.count ?? 0} nem pozitiv ar`,
    });

    const gatePassed = gateChecks.every((c) => c.passed);
    const gateReason = gatePassed
      ? null
      : gateChecks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`).join('; ');

    const shopsIncluded = new Set(offers.map((o) => o.shop_id)).size;

    // ── 5. Atomikus publikalas vagy karanten ─────────────────────────────
    if (!gatePassed || opts.dryRun) {
      await execute(
        `UPDATE market_publications
            SET status = 'quarantined', quality_gate_passed = false,
                quality_gate_report = $2::jsonb, quarantine_reason = $3,
                variants_total = $4, offers_total = $5, shops_included = $6
          WHERE id = $1`,
        [
          publicationId, JSON.stringify({ checks: gateChecks }),
          opts.dryRun ? 'Dry run - nem publikalunk.' : gateReason,
          byVariant.size, offersTotal, shopsIncluded,
        ],
      );
      logger.warn('publication.quarantined', { publicationId, reason: gateReason, dryRun: opts.dryRun });
      await raiseAlert({
        key: `publication:quarantined:${publicationId}`,
        level: 'error',
        category: 'quality_gate',
        title: 'A piaci publikacio karantenba kerult',
        message: gateReason ?? 'Dry run',
        detail: { publicationId, checks: gateChecks },
      });
      return {
        publicationId, generation, published: false,
        variantsTotal: byVariant.size, offersTotal, shopsIncluded,
        staleShops: [...staleShops],
        gate: { passed: gatePassed, checks: gateChecks },
        reason: gateReason,
      };
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE market_publications SET status = 'superseded' WHERE status = 'published'`,
      );
      await client.query(
        `UPDATE market_publications
            SET status = 'published', published_at = now(), quality_gate_passed = true,
                quality_gate_report = $2::jsonb, variants_total = $3, offers_total = $4,
                shops_included = $5, shops_stale = $6
          WHERE id = $1`,
        [
          publicationId, JSON.stringify({ checks: gateChecks }),
          byVariant.size, offersTotal, shopsIncluded,
          [...staleShops],
        ],
      );
    });

    // A regi generaciok takaritasa (az utolso 5 megmarad)
    await execute(
      `DELETE FROM market_publications
        WHERE status = 'superseded'
          AND id NOT IN (SELECT id FROM market_publications
                          WHERE status = 'superseded'
                          ORDER BY generation DESC LIMIT 5)`,
    );

    metrics.gauge('publication.variants', byVariant.size);
    metrics.gauge('publication.offers', offersTotal);
    metrics.timing('publication.duration_ms', Date.now() - started);

    logger.info('publication.published', {
      publicationId, generation, variants: byVariant.size, offers: offersTotal,
      shops: shopsIncluded, staleShops: staleShops.size, ms: Date.now() - started,
    });

    return {
      publicationId, generation, published: true,
      variantsTotal: byVariant.size, offersTotal, shopsIncluded,
      staleShops: [...staleShops],
      gate: { passed: true, checks: gateChecks },
      reason: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await execute(
      `UPDATE market_publications SET status = 'failed', quarantine_reason = $2 WHERE id = $1`,
      [publicationId, message],
    ).catch(() => undefined);
    logger.error('publication.failed', { publicationId, error: message });
    throw err;
  }
}

async function insertChunked(
  prefix: string,
  rows: string[],
  values: unknown[],
  columnsPerRow: number,
): Promise<void> {
  if (!rows.length) return;
  const chunkRows = Math.max(1, Math.floor(2000 / columnsPerRow));
  for (let i = 0; i < rows.length; i += chunkRows) {
    const rowSlice = rows.slice(i, i + chunkRows);
    const valueSlice = values.slice(i * columnsPerRow, (i + chunkRows) * columnsPerRow);
    // Placeholder-ujraszamozas a szeletre
    let n = 0;
    const renumbered = rowSlice.map(() =>
      `(${Array.from({ length: columnsPerRow }, () => `$${++n}`).join(',')})`,
    );
    await execute(prefix + renumbered.join(','), valueSlice);
  }
}

// ── Riasztas (spec 30.3) ────────────────────────────────────────────────────

export interface AlertInput {
  key: string;
  level: 'info' | 'warn' | 'error' | 'critical';
  category: 'crawler' | 'matching' | 'pricing' | 'quality_gate' | 'queue' | 'security' | 'backup' | 'system';
  title: string;
  message: string;
  shopId?: string | null;
  entityType?: string;
  entityId?: string;
  detail?: Record<string, unknown>;
}

/** Aggregalt, cselekvesre alkalmas riasztas. Ismetlodesnel csak szamlal. */
export async function raiseAlert(input: AlertInput): Promise<void> {
  await execute(
    `INSERT INTO alerts (alert_key, level, category, title, message, shop_id,
                         entity_type, entity_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (alert_key) WHERE resolved_at IS NULL
     DO UPDATE SET occurrence_count = alerts.occurrence_count + 1,
                   last_seen_at = now(),
                   message = EXCLUDED.message,
                   detail = EXCLUDED.detail`,
    [
      input.key, input.level, input.category, input.title, input.message,
      input.shopId ?? null, input.entityType ?? null, input.entityId ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  ).catch((err) => {
    logger.error('alert.write_failed', { key: input.key, error: String(err) });
  });
}
