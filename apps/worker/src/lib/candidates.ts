/**
 * Tobbcsatornas jeloltgeneralas (spec 14.).
 *
 * A korabbi rendszer fo hibaja az volt, hogy tul koran probalt vegso part
 * valasztani. Itt eloszor TOBB, reszben atfedo visszakeresesi csatornabol
 * allitunk elo kis, de nagy lefedettsegu jelolthalmazt - a dontes csak ezutan
 * kovetkezik.
 *
 * A tagabb query NEM lazitja a matching szabalyokat: minden jeloltre ugyanazok
 * a hard gate-ek futnak le.
 */
import type { Candidate, CandidateChannel, IdentityFields } from '@radovin/contracts';
import { emptyIdentityFields } from '@radovin/contracts';
import { query } from '@radovin/db';
import { buildBlockingKeys, buildQueryPlan, searchNorm, signatureTokens } from '@radovin/domain';
import { logger } from '@radovin/observability';

export interface CandidateRequest {
  /** A kanonikus oldal, amihez jeloltet keresunk. */
  canonicalVariantId: string;
  displayName: string;
  identity: IdentityFields;
  /** Melyik webshopban keresunk. */
  shopId: string;
  /** Csatornankenti max jeloltszam. */
  perChannelTopN?: number;
  totalTopN?: number;
  trigramMinSimilarity?: number;
  /** Kizarando listing ID-k (mar elutasitva azonos fingerprinttel). */
  excludeListingIds?: string[];
}

export interface CandidateResult {
  candidates: Candidate[];
  channelStats: Record<string, { found: number; durationMs: number }>;
  queryPlan: ReturnType<typeof buildQueryPlan>;
}

interface ListingRow {
  id: string;
  shop_id: string;
  shop_key: string;
  raw_name: string;
  normalized_name: string;
  canonical_url: string;
  image_url: string | null;
  identity_hash: string | null;
  extraction_quality: number;
  evidence: Record<string, unknown>;
  price_huf: number | null;
  category_key: string | null;
  producer_id: string | null;
  brand_id: string | null;
  expression: string | null;
  vintage_value: number | null;
  vintage_status: string;
  age_statement_years: number | null;
  volume_ml: number | null;
  pack_count: number;
  packaging_type: string;
  container_type: string | null;
  edition: string | null;
  cask_finish: string | null;
  dosage_style: string | null;
  sweetness: string | null;
  puttony: number | null;
  abv_percent: number | null;
  colour: string | null;
  region: string | null;
  country_code: string | null;
  grape_varieties: string[];
  gtin_normalized: string | null;
  sku: string | null;
  producer_name: string | null;
  brand_name: string | null;
  score?: number;
}

const LISTING_SELECT = `
  SELECT sl.id, sl.shop_id, s.key AS shop_key, sl.raw_name, sl.normalized_name,
         sl.canonical_url, sl.image_url, sl.identity_hash, sl.extraction_quality, sl.evidence,
         o.selected_comparable_price_huf AS price_huf,
         pc.key AS category_key,
         sl.producer_id, sl.brand_id, sl.expression, sl.vintage_value, sl.vintage_status,
         sl.age_statement_years, sl.volume_ml, sl.pack_count, sl.packaging_type,
         sl.container_type, sl.edition, sl.cask_finish, sl.dosage_style, sl.sweetness,
         sl.puttony, sl.abv_percent, sl.colour, sl.region, sl.country_code,
         sl.grape_varieties, sl.gtin_normalized, sl.sku,
         pr.canonical_name AS producer_name, br.canonical_name AS brand_name
    FROM source_listings sl
    JOIN shops s ON s.id = sl.shop_id
    LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
    LEFT JOIN product_categories pc ON pc.id = sl.category_id
    LEFT JOIN producers pr ON pr.id = sl.producer_id
    LEFT JOIN brands br ON br.id = sl.brand_id
`;

const ACTIVE_FILTER = `sl.listing_status = 'active' AND sl.shop_id = $SHOP`;

function toCandidate(row: ListingRow, channel: CandidateChannel, rank: number, score: number): Candidate {
  const identity: IdentityFields = {
    ...emptyIdentityFields(),
    categoryKey: row.category_key,
    producer: row.producer_name,
    producerId: row.producer_id,
    brand: row.brand_name,
    brandId: row.brand_id,
    expression: row.expression,
    vintageValue: row.vintage_value,
    vintageStatus: row.vintage_status as IdentityFields['vintageStatus'],
    ageStatementYears: row.age_statement_years,
    volumeMl: row.volume_ml,
    packCount: row.pack_count ?? 1,
    packagingType: row.packaging_type as IdentityFields['packagingType'],
    containerType: row.container_type,
    edition: row.edition,
    caskFinish: row.cask_finish,
    dosageStyle: row.dosage_style,
    sweetness: row.sweetness,
    puttony: row.puttony,
    abvPercent: row.abv_percent,
    colour: row.colour,
    region: row.region,
    countryCode: row.country_code,
    grapeVarieties: row.grape_varieties ?? [],
    gtin: row.gtin_normalized,
    sku: row.sku,
  };
  return {
    listingId: row.id,
    shopId: row.shop_id,
    shopKey: row.shop_key,
    identity,
    rawName: row.raw_name,
    normalizedName: row.normalized_name,
    identityHash: row.identity_hash ?? '',
    extractionQuality: row.extraction_quality ?? 0,
    evidence: (row.evidence ?? {}) as Candidate['evidence'],
    url: row.canonical_url,
    imageUrl: row.image_url,
    priceHuf: row.price_huf,
    channels: [{ channel, rank, score }],
  };
}

/**
 * Jeloltek gyujtese az osszes csatornabol. A csatornak sorrendje a spec 14.1
 * prioritasat koveti: mar igazolt kapcsolat -> eros azonosito -> blocking
 * kulcsok -> szoveges visszakereses.
 */
export async function generateCandidates(req: CandidateRequest): Promise<CandidateResult> {
  const perChannel = req.perChannelTopN ?? 25;
  const total = req.totalTopN ?? 60;
  const minSim = req.trigramMinSimilarity ?? 0.32;
  const exclude = req.excludeListingIds ?? [];

  const merged = new Map<string, Candidate>();
  const channelStats: CandidateResult['channelStats'] = {};

  const add = (rows: ListingRow[], channel: CandidateChannel, scoreOf: (r: ListingRow, i: number) => number) => {
    rows.forEach((row, index) => {
      if (exclude.includes(row.id)) return;
      const score = scoreOf(row, index);
      const existing = merged.get(row.id);
      if (existing) {
        existing.channels.push({ channel, rank: index + 1, score });
      } else {
        merged.set(row.id, toCandidate(row, channel, index + 1, score));
      }
    });
  };

  const run = async (
    channel: CandidateChannel,
    sql: string,
    params: unknown[],
    scoreOf: (r: ListingRow, i: number) => number,
  ): Promise<void> => {
    const started = Date.now();
    try {
      const rows = await query<ListingRow>(sql, params);
      add(rows, channel, scoreOf);
      channelStats[channel] = { found: rows.length, durationMs: Date.now() - started };
    } catch (err) {
      logger.warn('candidates.channel_failed', {
        channel, error: err instanceof Error ? err.message : String(err),
      });
      channelStats[channel] = { found: 0, durationMs: Date.now() - started };
    }
  };

  const i = req.identity;
  const shopFilter = ACTIVE_FILTER.replace('$SHOP', '$1');

  // ── A. Mar igazolt kapcsolat ────────────────────────────────────────────
  await run('verified_link',
    `${LISTING_SELECT}
      WHERE ${shopFilter}
        AND EXISTS (SELECT 1 FROM match_relations mr
                     WHERE mr.source_listing_id = sl.id
                       AND mr.canonical_variant_id = $2
                       AND mr.valid_to IS NULL
                       AND mr.status IN ('verified','proposed','drifted'))
      LIMIT ${perChannel}`,
    [req.shopId, req.canonicalVariantId],
    () => 1,
  );

  // ── B. Eros kulso azonosito: GTIN ───────────────────────────────────────
  if (i.gtin) {
    const digits = i.gtin.replace(/\D/g, '');
    if (digits.length >= 8) {
      await run('gtin',
        `${LISTING_SELECT}
          WHERE ${shopFilter}
            AND sl.gtin_normalized IS NOT NULL
            AND (sl.gtin_normalized = $2 OR ltrim(sl.gtin_normalized,'0') = ltrim($2,'0'))
          LIMIT ${perChannel}`,
        [req.shopId, digits],
        () => 1,
      );
    }
  }
  if (i.sku) {
    await run('sku',
      `${LISTING_SELECT} WHERE ${shopFilter} AND sl.sku = $2 LIMIT ${perChannel}`,
      [req.shopId, i.sku],
      () => 0.9,
    );
  }

  // ── C. Strukturalt blocking kulcsok, tobb passzban ─────────────────────
  const blockingKeys = buildBlockingKeys(i, req.displayName);
  for (const key of blockingKeys) {
    if (key.name === 'gtin_exact') continue; // mar lefutott
    const conditions: string[] = [shopFilter];
    const params: unknown[] = [req.shopId];
    const f = key.filter;

    if (f.producerId) { params.push(f.producerId); conditions.push(`sl.producer_id = $${params.length}`); }
    else if (f.brandId) { params.push(f.brandId); conditions.push(`sl.brand_id = $${params.length}`); }
    if (f.expressionNorm) { params.push(f.expressionNorm); conditions.push(`sl.expression_norm = $${params.length}`); }
    if (f.vintageValue !== undefined) { params.push(f.vintageValue); conditions.push(`sl.vintage_value = $${params.length}`); }
    if (f.volumeMl !== undefined) { params.push(f.volumeMl); conditions.push(`sl.volume_ml = $${params.length}`); }
    if (f.categoryKey) { params.push(f.categoryKey); conditions.push(`pc.key = $${params.length}`); }
    if (f.tokenSignature?.length) {
      params.push(f.tokenSignature);
      conditions.push(`sl.normalized_name ~ ('(' || array_to_string($${params.length}::text[], '|') || ')')`);
    }
    // Csak akkor futtatjuk, ha van legalabb ket ertelmes feltetel
    if (conditions.length < 3) continue;

    await run('catalog_block',
      `${LISTING_SELECT} WHERE ${conditions.join(' AND ')} LIMIT ${perChannel}`,
      params,
      () => (key.selectivity === 'high' ? 0.9 : key.selectivity === 'medium' ? 0.7 : 0.5),
    );
    if (merged.size >= total) break;
  }

  // ── D. PostgreSQL szoveges visszakereses ───────────────────────────────
  const plan = buildQueryPlan({ displayName: req.displayName, identity: i });
  const primaryQuery = searchNorm(plan.find((s) => s.level === 1)?.query ?? req.displayName);
  const brandQuery = searchNorm(i.producer ?? i.brand ?? '');
  const tokens = signatureTokens(req.displayName, i);

  // Teljes szoveges kereses (sulyozott: nev eros, leiras gyenge)
  await run('fts',
    `${LISTING_SELECT}, ts_rank(rv_tsv(sl.raw_name), plainto_tsquery('simple', $2)) AS score
      WHERE ${shopFilter}
        AND rv_tsv(sl.raw_name) @@ plainto_tsquery('simple', $2)
      ORDER BY score DESC LIMIT ${perChannel}`,
    [req.shopId, primaryQuery],
    (r) => Math.min(1, (r.score ?? 0) * 4),
  );

  // Trigram hasonlosag
  await run('trigram',
    `${LISTING_SELECT}, similarity(sl.normalized_name, $2) AS score
      WHERE ${shopFilter}
        AND sl.normalized_name % $2
        AND similarity(sl.normalized_name, $2) >= $3
      ORDER BY score DESC LIMIT ${perChannel}`,
    [req.shopId, primaryQuery, minSim],
    (r) => r.score ?? minSim,
  );

  // Szo-szintu hasonlosag (a rovidebb kanonikus nevekhez)
  if (brandQuery) {
    await run('word_similarity',
      `${LISTING_SELECT}, word_similarity($2, sl.normalized_name) AS score
        WHERE ${shopFilter}
          AND word_similarity($2, sl.normalized_name) >= 0.5
          ${i.volumeMl ? 'AND (sl.volume_ml = $3 OR sl.volume_ml IS NULL)' : ''}
        ORDER BY score DESC LIMIT ${perChannel}`,
      i.volumeMl ? [req.shopId, brandQuery, i.volumeMl] : [req.shopId, brandQuery],
      (r) => (r.score ?? 0.5) * 0.85,
    );
  }

  // Token-alapu, tagabb halo: a marka + legalabb egy identitastoken
  if (brandQuery && tokens.length) {
    await run('trigram',
      `${LISTING_SELECT}, similarity(sl.normalized_name, $2) AS score
        WHERE ${shopFilter}
          AND sl.normalized_name LIKE '%' || $2 || '%'
          AND sl.normalized_name ~ ('(' || array_to_string($3::text[], '|') || ')')
        ORDER BY score DESC LIMIT ${perChannel}`,
      [req.shopId, brandQuery, tokens],
      (r) => (r.score ?? 0.4) * 0.8,
    );
  }

  // ── E. Alias-alapu visszakereses ───────────────────────────────────────
  if (i.brandId || i.producerId) {
    await run('alias',
      `${LISTING_SELECT}
        WHERE ${shopFilter}
          AND EXISTS (
            SELECT 1 FROM aliases a
             WHERE a.approved AND a.active
               AND a.alias_type IN ('brand','producer','expression')
               AND (a.shop_id IS NULL OR a.shop_id = sl.shop_id)
               AND a.target_id IN ($2, $3)
               AND sl.normalized_name LIKE '%' || a.alias_norm || '%')
        LIMIT ${perChannel}`,
      [req.shopId, i.brandId ?? i.producerId, i.producerId ?? i.brandId],
      () => 0.75,
    );
  }

  const candidates = [...merged.values()]
    .map((c) => {
      // A csatornak legerosebb pontszama hatarozza meg a rangsort
      const best = Math.max(...c.channels.map((ch) => ch.score));
      return { candidate: c, best };
    })
    .sort((a, b) => b.best - a.best)
    .slice(0, total)
    .map((x) => x.candidate);

  return { candidates, channelStats, queryPlan: plan };
}

/**
 * Fordított irany: egy webshoplistinghez keresunk kanonikus valtozat-jelolteket
 * (spec 9.5 automatikus klaszterezes).
 */
export async function generateVariantCandidates(
  listing: { identity: IdentityFields; rawName: string; normalizedName: string },
  opts: { topN?: number; minSimilarity?: number } = {},
): Promise<Array<{ id: string; displayName: string; identity: IdentityFields; score: number; channel: CandidateChannel }>> {
  const topN = opts.topN ?? 25;
  const minSim = opts.minSimilarity ?? 0.32;
  const i = listing.identity;
  const out = new Map<string, { id: string; displayName: string; identity: IdentityFields; score: number; channel: CandidateChannel }>();

  const VARIANT_SELECT = `
    SELECT cv.id, cv.canonical_display_name, cv.vintage_value, cv.vintage_status,
           cv.age_statement_years, cv.volume_ml, cv.pack_count, cv.packaging_type,
           cv.edition, cv.cask_finish, cv.dosage_style, cv.puttony, cv.abv_percent,
           cv.gtin_normalized, pf.producer_id, pf.brand_id, pf.product_line, pf.region,
           pf.colour, pf.grape_varieties, pf.origin_country,
           pc.key AS category_key, pr.canonical_name AS producer_name, br.canonical_name AS brand_name
      FROM canonical_variants cv
      JOIN product_families pf ON pf.id = cv.product_family_id
      JOIN product_categories pc ON pc.id = pf.category_id
      LEFT JOIN producers pr ON pr.id = pf.producer_id
      LEFT JOIN brands br ON br.id = pf.brand_id
     WHERE cv.status IN ('active','proposed')
  `;

  interface VariantRow {
    id: string; canonical_display_name: string; vintage_value: number | null;
    vintage_status: string; age_statement_years: number | null; volume_ml: number | null;
    pack_count: number; packaging_type: string; edition: string | null;
    cask_finish: string | null; dosage_style: string | null; puttony: number | null;
    abv_percent: number | null; gtin_normalized: string | null;
    producer_id: string | null; brand_id: string | null; product_line: string | null;
    region: string | null; colour: string | null; grape_varieties: string[];
    origin_country: string | null; category_key: string; producer_name: string | null;
    brand_name: string | null; score?: number;
  }

  const toVariant = (r: VariantRow, score: number, channel: CandidateChannel) => ({
    id: r.id,
    displayName: r.canonical_display_name,
    score,
    channel,
    identity: {
      ...emptyIdentityFields(),
      categoryKey: r.category_key,
      producer: r.producer_name, producerId: r.producer_id,
      brand: r.brand_name, brandId: r.brand_id,
      expression: r.product_line ?? r.canonical_display_name,
      vintageValue: r.vintage_value,
      vintageStatus: r.vintage_status as IdentityFields['vintageStatus'],
      ageStatementYears: r.age_statement_years,
      volumeMl: r.volume_ml, packCount: r.pack_count ?? 1,
      packagingType: r.packaging_type as IdentityFields['packagingType'],
      edition: r.edition, caskFinish: r.cask_finish, dosageStyle: r.dosage_style,
      puttony: r.puttony, abvPercent: r.abv_percent, colour: r.colour,
      region: r.region, countryCode: r.origin_country,
      grapeVarieties: r.grape_varieties ?? [], gtin: r.gtin_normalized,
    } as IdentityFields,
  });

  const push = (rows: VariantRow[], channel: CandidateChannel, scoreOf: (r: VariantRow) => number) => {
    for (const r of rows) {
      const score = scoreOf(r);
      const existing = out.get(r.id);
      if (!existing || existing.score < score) out.set(r.id, toVariant(r, score, channel));
    }
  };

  // GTIN
  if (i.gtin) {
    const digits = i.gtin.replace(/\D/g, '');
    if (digits.length >= 8) {
      const rows = await query<VariantRow>(
        `${VARIANT_SELECT} AND cv.gtin_normalized IS NOT NULL
           AND (cv.gtin_normalized = $1 OR ltrim(cv.gtin_normalized,'0') = ltrim($1,'0'))
         LIMIT ${topN}`,
        [digits],
      );
      push(rows, 'gtin', () => 1);
    }
  }

  // Blocking: termelo/marka + kiszereles (+ evjarat)
  if ((i.producerId || i.brandId) && i.volumeMl) {
    const rows = await query<VariantRow>(
      `${VARIANT_SELECT}
         AND (pf.producer_id = $1 OR pf.brand_id = $2)
         AND cv.volume_ml = $3
         AND ($4::int IS NULL OR cv.vintage_value IS NULL OR cv.vintage_value = $4)
       LIMIT ${topN}`,
      [i.producerId ?? null, i.brandId ?? null, i.volumeMl, i.vintageValue],
    );
    push(rows, 'catalog_block', () => 0.9);
  }

  // Trigram a megjelenitett neven
  const norm = searchNorm(listing.rawName);
  const rows = await query<VariantRow>(
    `${VARIANT_SELECT}
       AND cv.display_name_norm % $1
       AND similarity(cv.display_name_norm, $1) >= $2
     ORDER BY similarity(cv.display_name_norm, $1) DESC LIMIT ${topN}`,
    [norm, minSim],
  );
  push(rows, 'trigram', (r) => r.score ?? minSim);

  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, topN);
}
