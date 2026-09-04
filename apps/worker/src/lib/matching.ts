/**
 * A parositasi dontes vegrehajtasa es perzisztalasa (spec 15., 16., 17.).
 *
 * Ez a reteg koti ossze a jeloltgeneralast, a bizonyitekalapu motort es az
 * adatbazist. A dontesi logika NEM itt van - az a @radovin/domain csomagban,
 * webshop-fuggetlenul (spec 38/4, 38/5).
 */
import type {
  Candidate, IdentityFields, MatchDecisionResult, MatchPolicy, MatchStatus,
} from '@radovin/contracts';
import { REASON_CODES, REASON_CODE_HU, emptyIdentityFields } from '@radovin/contracts';
import { execute, query, queryOne, transaction } from '@radovin/db';
import {
  decideMatch, resolveIdentityProfile, type CanonicalSide, type Taxonomy,
} from '@radovin/domain';
import { logger } from '@radovin/observability';
import { generateCandidates } from './candidates.js';

export interface VariantRow {
  id: string;
  canonical_display_name: string;
  identity_hash: string | null;
  vintage_value: number | null;
  vintage_status: string;
  age_statement_years: number | null;
  volume_ml: number | null;
  pack_count: number;
  packaging_type: string;
  edition: string | null;
  cask_finish: string | null;
  dosage_style: string | null;
  sweetness: string | null;
  puttony: number | null;
  abv_percent: number | null;
  gtin_normalized: string | null;
  identity_profile_json: Record<string, unknown>;
  comparison_policy_json: Record<string, unknown>;
  producer_id: string | null;
  brand_id: string | null;
  producer_name: string | null;
  brand_name: string | null;
  product_line: string | null;
  region: string | null;
  colour: string | null;
  origin_country: string | null;
  grape_varieties: string[];
  wine_style_id: string | null;
  vineyard_id: string | null;
  wine_region_id: string | null;
  grape_signature: string | null;
  grape_ids: string[] | null;
  reference_price_huf: number | null;
  category_key: string;
  category_identity_profile: Record<string, unknown>;
  category_comparison_policy: Record<string, unknown>;
}

export const VARIANT_QUERY = `
  SELECT cv.id, cv.canonical_display_name, cv.identity_hash, cv.vintage_value, cv.vintage_status,
         cv.age_statement_years, cv.volume_ml, cv.pack_count, cv.packaging_type, cv.edition,
         cv.cask_finish, cv.dosage_style, cv.sweetness, cv.puttony, cv.abv_percent,
         cv.gtin_normalized, cv.identity_profile_json, cv.comparison_policy_json,
         cv.wine_style_id, cv.vineyard_id, cv.wine_region_id, cv.grape_signature,
         cvg.ids AS grape_ids, refp.price AS reference_price_huf,
         pf.producer_id, pf.brand_id, pf.product_line, pf.region, pf.colour,
         pf.origin_country, pf.grape_varieties,
         pr.canonical_name AS producer_name, br.canonical_name AS brand_name,
         pc.key AS category_key,
         pc.identity_profile AS category_identity_profile,
         pc.comparison_policy AS category_comparison_policy
    FROM canonical_variants cv
    JOIN product_families pf ON pf.id = cv.product_family_id
    JOIN product_categories pc ON pc.id = pf.category_id
    LEFT JOIN producers pr ON pr.id = pf.producer_id
    LEFT JOIN brands br ON br.id = pf.brand_id
    LEFT JOIN LATERAL (
      SELECT array_agg(g.grape_variety_id::text) AS ids
        FROM canonical_variant_grapes g
       WHERE g.canonical_variant_id = cv.id
    ) cvg ON true
    -- Viszonyitasi ar: a mar IGAZOLT boltok legolcsobb osszehasonlithato ara.
    -- Csak az automatikus jovahagyas oreként hasznaljuk; az azonossagot nem
    -- bizonyitja es nem cafolja.
    LEFT JOIN LATERAL (
      SELECT min(o.selected_comparable_price_huf) AS price
        FROM match_relations mr
        JOIN source_listings sl2 ON sl2.id = mr.source_listing_id
        JOIN offer_observations o ON o.id = sl2.latest_offer_id
       WHERE mr.canonical_variant_id = cv.id
         AND mr.status = 'verified' AND mr.valid_to IS NULL
         AND o.comparable AND NOT o.quarantined
    ) refp ON true
`;

export function variantIdentity(row: VariantRow): IdentityFields {
  return {
    ...emptyIdentityFields(),
    categoryKey: row.category_key,
    producer: row.producer_name,
    producerId: row.producer_id,
    brand: row.brand_name,
    brandId: row.brand_id,
    expression: row.product_line ?? row.canonical_display_name,
    vintageValue: row.vintage_value,
    vintageStatus: row.vintage_status as IdentityFields['vintageStatus'],
    ageStatementYears: row.age_statement_years,
    volumeMl: row.volume_ml,
    packCount: row.pack_count ?? 1,
    packagingType: row.packaging_type as IdentityFields['packagingType'],
    edition: row.edition,
    caskFinish: row.cask_finish,
    dosageStyle: row.dosage_style,
    sweetness: row.sweetness,
    puttony: row.puttony,
    abvPercent: row.abv_percent,
    colour: row.colour,
    region: row.region,
    countryCode: row.origin_country,
    grapeVarieties: row.grape_varieties ?? [],
    gtin: row.gtin_normalized,
    grapeVarietyIds: row.grape_ids ?? [],
    grapeSignature: row.grape_signature,
    wineStyleId: row.wine_style_id,
    vineyardId: row.vineyard_id,
    wineRegionId: row.wine_region_id,
  };
}

export function canonicalSide(row: VariantRow): CanonicalSide {
  return {
    id: row.id,
    displayName: row.canonical_display_name,
    identity: variantIdentity(row),
    // A kanonikus oldal import/kezi felvitelbol szarmazik: megbizhato
    extractionQuality: 1.0,
    identityHash: row.identity_hash ?? '',
    referencePriceHuf: row.reference_price_huf,
  };
}

export interface EvaluateOptions {
  variant: VariantRow;
  shopId: string;
  shopKey: string;
  taxonomy: Taxonomy;
  policy: MatchPolicy;
  sourceHealthy: boolean;
  crawlRunId?: string | null;
  correlationId?: string;
  candidateLimits?: { perChannelTopN: number; totalTopN: number; trigramMinSimilarity: number };
}

export interface EvaluateResult {
  decision: MatchDecisionResult;
  candidateCount: number;
  candidatesAfterGate: number;
  channelStats: Record<string, { found: number; durationMs: number }>;
  reviewCaseId: string | null;
  matchRelationId: string | null;
}

/**
 * Egy kanonikus valtozat kiertekelese EGY webshopra.
 * Vegigviszi: jeloltgeneralas -> negativ memoria -> dontes -> perzisztalas.
 */
export async function evaluateVariantForShop(opts: EvaluateOptions): Promise<EvaluateResult> {
  const started = Date.now();
  const { variant, shopId, shopKey, taxonomy, policy } = opts;
  const identity = variantIdentity(variant);

  const profile = resolveIdentityProfile({
    categoryProfile: variant.category_identity_profile as never,
    categoryPolicy: variant.category_comparison_policy as never,
    variantProfile: Object.keys(variant.identity_profile_json ?? {}).length
      ? (variant.identity_profile_json as never) : null,
    variantPolicy: Object.keys(variant.comparison_policy_json ?? {}).length
      ? (variant.comparison_policy_json as never) : null,
  });

  // ── Negativ memoria (spec 14.3) ─────────────────────────────────────────
  const rejected = await query<{ source_listing_id: string; listing_identity_hash: string; count: number }>(
    `SELECT rc.source_listing_id, rc.listing_identity_hash, count(*)::int AS count
       FROM rejected_candidates rc
      WHERE rc.canonical_variant_id = $1 AND rc.shop_id = $2 AND rc.reopened_at IS NULL
      GROUP BY rc.source_listing_id, rc.listing_identity_hash`,
    [variant.id, shopId],
  );

  // Azonos fingerprint mellett a jelolt NEM kerul ujra a review sorba.
  // Megvaltozott fingerprint eseten viszont ujra ertekelheto.
  const currentHashes = rejected.length
    ? await query<{ id: string; identity_hash: string | null }>(
      `SELECT id, identity_hash FROM source_listings WHERE id = ANY($1::uuid[])`,
      [rejected.map((r) => r.source_listing_id)],
    )
    : [];
  const hashById = new Map(currentHashes.map((r) => [r.id, r.identity_hash ?? '']));
  const hardExcluded: string[] = [];
  const negativeHistory = new Map<string, number>();
  for (const r of rejected) {
    negativeHistory.set(r.source_listing_id, r.count);
    if (hashById.get(r.source_listing_id) === r.listing_identity_hash) {
      hardExcluded.push(r.source_listing_id);
    }
  }

  // ── Mar ember altal igazolt kapcsolatok ─────────────────────────────────
  const verified = await query<{ source_listing_id: string }>(
    `SELECT source_listing_id FROM match_relations
      WHERE canonical_variant_id = $1 AND shop_id = $2
        AND status = 'verified' AND verified_kind = 'human_verified' AND valid_to IS NULL`,
    [variant.id, shopId],
  );
  const verifiedIds = new Set(verified.map((v) => v.source_listing_id));

  // ── Jeloltgeneralas (spec 14.) ──────────────────────────────────────────
  const generation = await generateCandidates({
    canonicalVariantId: variant.id,
    displayName: variant.canonical_display_name,
    identity,
    shopId,
    excludeListingIds: hardExcluded,
    ...(opts.candidateLimits ?? {}),
  });

  // ── Dontes (spec 15.) ───────────────────────────────────────────────────
  const decision = decideMatch({
    canonical: canonicalSide(variant),
    candidates: generation.candidates,
    profile,
    policy,
    comparatorCtx: {
      aliasResolver: taxonomy.aliasResolver,
      negativeAliasCheck: taxonomy.negativeAliasCheck,
      fuzzyBlocked: (side) =>
        side === 'left'
          ? taxonomy.isFuzzyBlocked(identity.brandId ?? identity.producerId)
          : false,
      shopId,
    },
    negativeHistory,
    verifiedListingIds: verifiedIds,
    sourceHealthy: opts.sourceHealthy,
  });

  const persisted = await persistDecision({
    decision, variant, shopId, shopKey, policy,
    crawlRunId: opts.crawlRunId ?? null,
    candidates: generation.candidates,
  });

  // ── Keresesi memoria (spec 16.3) ────────────────────────────────────────
  await execute(
    `INSERT INTO search_attempts
       (canonical_variant_id, shop_id, crawl_run_id, finished_at, query_plan, channels_used,
        channel_results, candidates_found, candidates_after_gate, outcome,
        source_health_at_time, reason_codes, duration_ms, detail)
     VALUES ($1,$2,$3, now(), $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      variant.id, shopId, opts.crawlRunId ?? null,
      JSON.stringify(generation.queryPlan),
      Object.keys(generation.channelStats),
      JSON.stringify(generation.channelStats),
      generation.candidates.length,
      decision.runnerUp.filter((r) => !r.rejected).length,
      outcomeOf(decision.status),
      opts.sourceHealthy ? 'ok' : 'unhealthy',
      decision.reasonCodes,
      Date.now() - started,
      JSON.stringify({ explanation: decision.explanationHu, topMargin: decision.topMargin }),
    ],
  );

  return {
    decision,
    candidateCount: generation.candidates.length,
    candidatesAfterGate: decision.runnerUp.filter((r) => !r.rejected).length,
    channelStats: generation.channelStats,
    reviewCaseId: persisted.reviewCaseId,
    matchRelationId: persisted.matchRelationId,
  };
}

function outcomeOf(status: MatchStatus): string {
  switch (status) {
    case 'auto_verified':
    case 'human_verified': return 'matched';
    case 'needs_review': return 'needs_review';
    case 'ambiguous': return 'ambiguous';
    case 'insufficient_evidence': return 'insufficient_evidence';
    case 'not_found_after_full_search': return 'not_found';
    case 'source_unhealthy': return 'source_unhealthy';
    default: return 'search_incomplete';
  }
}

interface PersistDecisionOpts {
  decision: MatchDecisionResult;
  variant: VariantRow;
  shopId: string;
  shopKey: string;
  policy: MatchPolicy;
  crawlRunId: string | null;
  candidates: Candidate[];
}

/**
 * A dontes tarolasa: match_decisions + match_relations + variant_shop_status
 * + szukseg eseten review_case. Minden verziozott es magyarazhato.
 */
export async function persistDecision(
  opts: PersistDecisionOpts,
): Promise<{ reviewCaseId: string | null; matchRelationId: string | null }> {
  const { decision, variant, shopId, policy } = opts;

  return transaction(async (client) => {
    let matchRelationId: string | null = null;

    // ── Automatikusan igazolt par ─────────────────────────────────────────
    if (decision.status === 'auto_verified' && decision.sourceListingId) {
      const relation = await client.query<{ id: string }>(
        `INSERT INTO match_relations
           (canonical_variant_id, source_listing_id, shop_id, status, decision_origin,
            verified_kind, confidence, identity_hash_at_decision, last_verified_at)
         SELECT $1, $2, $3, 'verified', 'auto', 'auto_verified', $4, sl.identity_hash, now()
           FROM source_listings sl WHERE sl.id = $2
         ON CONFLICT (canonical_variant_id, source_listing_id) WHERE valid_to IS NULL
         DO UPDATE SET status = 'verified', last_verified_at = now(),
                       confidence = EXCLUDED.confidence,
                       identity_hash_at_decision = EXCLUDED.identity_hash_at_decision,
                       drift_detected_at = NULL, drift_reason = NULL,
                       version = match_relations.version + 1
         RETURNING id`,
        [variant.id, decision.sourceListingId, shopId, decision.decisionStrength],
      );
      matchRelationId = relation.rows[0]?.id ?? null;
      await client.query(
        `UPDATE source_listings SET cluster_status = 'clustered' WHERE id = $1`,
        [decision.sourceListingId],
      );
    }

    // ── Dontesi rekord (audit) ────────────────────────────────────────────
    const decisionRow = await client.query<{ id: string }>(
      `INSERT INTO match_decisions
         (match_relation_id, canonical_variant_id, source_listing_id, shop_id, status,
          matcher_version, taxonomy_version, policy_version, candidate_sources,
          candidate_ranks, field_results, hard_contradictions,
          agreement_score, evidence_coverage, extraction_quality, retrieval_support,
          top_margin, decision_strength, contradiction_count, negative_history,
          reason_codes, explanation_hu, runner_up, decision_json, decided_by, crawl_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
               $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,'engine',$25)
       RETURNING id`,
      [
        matchRelationId, variant.id, decision.sourceListingId, shopId, decision.status,
        policy.matcherVersion, policy.taxonomyVersion, policy.policyVersion,
        decision.candidateSources,
        JSON.stringify(Object.fromEntries(
          opts.candidates.map((c) => [c.listingId, c.channels]),
        )),
        JSON.stringify(decision.fieldResults),
        JSON.stringify(decision.hardContradictions),
        decision.agreementScore, decision.evidenceCoverage, decision.extractionQuality,
        decision.retrievalSupport, decision.topMargin, decision.decisionStrength,
        decision.contradictionCount, decision.negativeHistory,
        decision.reasonCodes, decision.explanationHu,
        JSON.stringify(decision.runnerUp), JSON.stringify(decision),
        opts.crawlRunId,
      ],
    );
    const decisionId = decisionRow.rows[0]!.id;
    if (matchRelationId) {
      await client.query('UPDATE match_relations SET current_decision_id = $2 WHERE id = $1', [matchRelationId, decisionId]);
    }

    // ── variant_shop_status frissitese ────────────────────────────────────
    const nextSearchInterval = nextSearchFor(decision.status);
    await client.query(
      `INSERT INTO variant_shop_status
         (canonical_variant_id, shop_id, status, matched_listing_id, last_search_at,
          last_full_search_at, search_attempt_count, consecutive_no_match,
          next_search_at, best_rejected_score, primary_reason_code, reason_codes)
       VALUES ($1,$2,$3,$4, now(), CASE WHEN $5 THEN now() ELSE NULL END, 1,
               CASE WHEN $6 THEN 1 ELSE 0 END,
               now() + $7::interval, $8, $9, $10)
       ON CONFLICT (canonical_variant_id, shop_id) DO UPDATE SET
         status = EXCLUDED.status,
         matched_listing_id = EXCLUDED.matched_listing_id,
         last_search_at = now(),
         last_full_search_at = CASE WHEN $5 THEN now() ELSE variant_shop_status.last_full_search_at END,
         search_attempt_count = variant_shop_status.search_attempt_count + 1,
         consecutive_no_match = CASE WHEN $6 THEN variant_shop_status.consecutive_no_match + 1 ELSE 0 END,
         next_search_at = now() + $7::interval,
         best_rejected_score = EXCLUDED.best_rejected_score,
         primary_reason_code = EXCLUDED.primary_reason_code,
         reason_codes = EXCLUDED.reason_codes`,
      [
        variant.id, shopId, decision.status,
        decision.status === 'auto_verified' || decision.status === 'human_verified'
          ? decision.sourceListingId : null,
        decision.status === 'not_found_after_full_search',
        decision.status === 'not_found_after_full_search' || decision.status === 'insufficient_evidence',
        nextSearchInterval,
        decision.decisionStrength,
        decision.reasonCodes[0] ?? null,
        decision.reasonCodes,
      ],
    );

    // ── A mar NYITOTT eset lezarasa, ha a gep kozben biztos lett ─────────
    //
    // Enelkul az automatika sosem csokkentene a sort: az eset akkor
    // keletkezett, amikor a gep nem tudott donteni, es nyitva maradna akkor
    // is, ha kesobb - egy jovahagyott boraszattal, egy kitoltott fajtaval -
    // mar tud. Az ember ugyanazt latna, amit a rendszer mar eldontott.
    //
    // Csak a MEG NEM ERINTETT (`open`) eseteket zarjuk. Amit valaki elkezdett
    // (`in_progress`) vagy tudatosan elhalasztott (`deferred`), ahhoz nem
    // nyulunk - az emberi szandek erosebb.
    if (decision.status === 'auto_verified' || decision.status === 'rejected') {
      const note = decision.status === 'auto_verified'
        ? 'A gep idokozben teljes bizonyitott azonossagot talalt.'
        : 'A gep idokozben kizaro ellentmondast talalt.';
      const closed = await client.query<{ id: string }>(
        `UPDATE review_cases
            SET status = 'resolved', resolution = 'auto_resolved',
                resolution_note = $3, resolved_at = now(),
                row_version = row_version + 1
          WHERE canonical_variant_id = $1 AND shop_id = $2 AND status = 'open'
        RETURNING id`,
        [variant.id, shopId, note],
      );
      for (const c of closed.rows) {
        await client.query(
          `INSERT INTO review_case_events (review_case_id, action, note)
           VALUES ($1, 'auto_resolved', $2)`,
          [c.id, `${note} (${decision.reasonCodes.slice(0, 3).join(', ')})`],
        );
      }
      if (closed.rows.length) {
        logger.info('review.auto_resolved', {
          canonicalVariantId: variant.id, shopId,
          esetek: closed.rows.length, allapot: decision.status,
        });
      }
    }

    // ── Review case, ha emberi dontes kell (spec 24.) ────────────────────
    let reviewCaseId: string | null = null;
    const needsReview =
      decision.status === 'needs_review' || decision.status === 'ambiguous';

    // Mar igazolt (valtozat, bolt) parra NEM nyitunk esetet. A dontes
    // megszuletett; egy ujrafuttatas ebbol nem csinalhat ujra teendot -
    // kulonben a sor magatol notte volna vissza magat minden korben.
    const alreadyVerified = await client.query<{ id: string }>(
      `SELECT id FROM match_relations
        WHERE canonical_variant_id = $1 AND shop_id = $2
          AND status = 'verified' AND valid_to IS NULL
        LIMIT 1`,
      [variant.id, shopId],
    );

    if (needsReview && decision.sourceListingId && !alreadyVerified.rows[0]) {
      const caseType = decision.status === 'ambiguous' ? 'ambiguous' : 'new_match';
      // A sorrend a hozamot koveti. A teljesen bizonyitott azonossagu eset -
      // amit csak egy or (jellemzoen a kiugro ararany) tartott vissza - egy
      // kattintassal lezarhato, es sokszor eppen az a legertekesebb talalat:
      // vagy a legjobb ar a piacon, vagy egy hiba. Ezek menjenek elore.
      const priority = decision.status === 'ambiguous' ? 20
        : decision.identityComplete ? 30
        : 50;
      const title = `${variant.canonical_display_name} <-> ${opts.shopKey}: ${
        decision.reasonCodes.map((c) => REASON_CODE_HU[c] ?? c).slice(0, 2).join(', ') || 'ellenorzes szukseges'
      }`;

      const context = JSON.stringify({
        explanation: decision.explanationHu,
        fieldResults: decision.fieldResults,
        agreementScore: decision.agreementScore,
        evidenceCoverage: decision.evidenceCoverage,
        extractionQuality: decision.extractionQuality,
        topMargin: decision.topMargin,
        candidateSources: decision.candidateSources,
        priceRatio: decision.priceRatio ?? null,
      });

      // Egy valtozatot egy boltban egyszerre EGY nyitott eset kepvisel.
      // Melyik listing a legjobb jelolt, az a dontes TARTALMA, nem az
      // azonossaga - ezert egy ujrafuttatas frissiti a meglevo esetet, nem
      // nyit masodikat. (A regi viselkedes miatt a sor magatol nott.)
      //
      // Kifejezett keres-majd-ir, mert az egyedi index reszleges es
      // kifejezes-alapu; az `ON CONFLICT` inferencia ott nehezen olvashato.
      // A keresés SZANDEKOSAN nem szur `case_type`-ra. A `new_match` es az
      // `ambiguous` nem ket kulonbozo UGY, hanem ugyanannak a parnak a ket
      // lehetseges kimenetele - egy ujrafuttatas atbillentheti egyikbol a
      // masikba. Ha a keresés a tipusra szurne, az atbillenes MASODIK nyitott
      // esetet nyitna ugyanarra a parra: a feluleten ket azonos kartya
      // jelent meg ugyanabbol a boltbol, ugyanazzal az arral.
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM review_cases
          WHERE case_type IN ('new_match','ambiguous')
            AND canonical_variant_id = $1 AND shop_id = $2
            AND status IN ('open','in_progress','deferred')
          LIMIT 1`,
        [variant.id, shopId],
      );

      if (existing.rows[0]) {
        reviewCaseId = existing.rows[0].id;
        // A tipus is frissul: ha a par kozben dontetlenne valt, azt a
        // meglevo eset viseli tovabb - nem egy masodik sor.
        await client.query(
          `UPDATE review_cases SET
             case_type = $10,
             source_listing_id = $2, match_decision_id = $3, title = $4,
             reason_codes = $5, confidence = $6, candidates = $7::jsonb,
             context = $8::jsonb, priority = $9, row_version = row_version + 1
           WHERE id = $1`,
          [
            reviewCaseId, decision.sourceListingId, decisionId, title.slice(0, 300),
            decision.reasonCodes, decision.decisionStrength,
            JSON.stringify(decision.runnerUp), context, priority, caseType,
          ],
        );
      } else {
        const created = await client.query<{ id: string }>(
          `INSERT INTO review_cases
             (case_type, priority, status, canonical_variant_id, source_listing_id, shop_id,
              match_decision_id, title, reason_codes, confidence, candidates, context, due_at)
           VALUES ($1,$2,'open',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,
                   now() + interval '72 hours')
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            caseType, priority, variant.id, decision.sourceListingId, shopId, decisionId,
            title.slice(0, 300), decision.reasonCodes, decision.decisionStrength,
            JSON.stringify(decision.runnerUp), context,
          ],
        );
        reviewCaseId = created.rows[0]?.id ?? null;
      }

      // A jelolt listing allapota: review-ban
      await client.query(
        `UPDATE source_listings SET cluster_status = 'needs_review'
          WHERE id = $1 AND cluster_status IN ('unclustered','searching')`,
        [decision.sourceListingId],
      );
    }

    // ── Automatikus elutasitas -> negativ memoria ────────────────────────
    if (decision.status === 'rejected' && decision.sourceListingId) {
      await client.query(
        `INSERT INTO rejected_candidates
           (canonical_variant_id, source_listing_id, shop_id, rejected_by, reason_code,
            reason_note, listing_identity_hash, variant_identity_hash, score_at_rejection)
         SELECT $1, $2, $3, 'engine', $4, $5,
                coalesce(sl.identity_hash,''), coalesce(cv.identity_hash,''), $6
           FROM source_listings sl, canonical_variants cv
          WHERE sl.id = $2 AND cv.id = $1
         ON CONFLICT DO NOTHING`,
        [
          variant.id, decision.sourceListingId, shopId,
          decision.hardContradictions[0]?.code ?? REASON_CODES.MANUAL_REJECTION,
          decision.explanationHu, decision.decisionStrength,
        ],
      );
    }

    return { reviewCaseId, matchRelationId };
  });
}

/** Ismetelt keresesi strategia (spec 16.2). */
function nextSearchFor(status: MatchStatus): string {
  switch (status) {
    case 'auto_verified':
    case 'human_verified': return '7 days';
    case 'needs_review':
    case 'ambiguous': return '14 days';
    case 'insufficient_evidence': return '7 days';
    case 'not_found_after_full_search': return '7 days';
    case 'source_unhealthy': return '1 day';
    case 'listing_missing': return '1 day';
    case 'rejected': return '30 days';
    default: return '3 days';
  }
}

/**
 * Egy uj/valtozott webshoplisting klaszterezese: melyik kanonikus valtozathoz
 * tartozik? Ha egyikhez sem, javaslat keszul (spec 9.5).
 */
export async function evaluateListingForClustering(opts: {
  listingId: string;
  taxonomy: Taxonomy;
  policy: MatchPolicy;
  crawlRunId?: string | null;
}): Promise<{ status: string; canonicalVariantId: string | null; reviewCaseId: string | null }> {
  const listing = await queryOne<{
    id: string; shop_id: string; shop_key: string; raw_name: string; normalized_name: string;
    identity_hash: string | null; extraction_quality: number; canonical_url: string;
    category_key: string | null; producer_id: string | null; brand_id: string | null;
    expression: string | null; vintage_value: number | null; vintage_status: string;
    age_statement_years: number | null; volume_ml: number | null; pack_count: number;
    packaging_type: string; edition: string | null; cask_finish: string | null;
    dosage_style: string | null; puttony: number | null; abv_percent: number | null;
    gtin_normalized: string | null; producer_name: string | null; brand_name: string | null;
    colour: string | null; region: string | null; grape_varieties: string[] | null;
    wine_style_id: string | null; vineyard_id: string | null; wine_region_id: string | null;
    grape_signature: string | null; grape_ids: string[] | null;
    price_huf: number | null;
  }>(
    `SELECT sl.id, sl.shop_id, s.key AS shop_key, sl.raw_name, sl.normalized_name,
            sl.identity_hash, sl.extraction_quality, sl.canonical_url,
            pc.key AS category_key, sl.producer_id, sl.brand_id, sl.expression,
            sl.vintage_value, sl.vintage_status, sl.age_statement_years, sl.volume_ml,
            sl.pack_count, sl.packaging_type, sl.edition, sl.cask_finish, sl.dosage_style,
            sl.puttony, sl.abv_percent, sl.gtin_normalized,
            sl.colour, sl.region, sl.grape_varieties,
            sl.wine_style_id, sl.vineyard_id, sl.wine_region_id, sl.grape_signature,
            slg.ids AS grape_ids, o.selected_comparable_price_huf AS price_huf,
            pr.canonical_name AS producer_name, br.canonical_name AS brand_name
       FROM source_listings sl
       JOIN shops s ON s.id = sl.shop_id
       LEFT JOIN offer_observations o ON o.id = sl.latest_offer_id
       LEFT JOIN product_categories pc ON pc.id = sl.category_id
       LEFT JOIN producers pr ON pr.id = sl.producer_id
       LEFT JOIN brands br ON br.id = sl.brand_id
       LEFT JOIN LATERAL (
         SELECT array_agg(g.grape_variety_id::text) AS ids
           FROM source_listing_grapes g
          WHERE g.source_listing_id = sl.id
       ) slg ON true
      WHERE sl.id = $1`,
    [opts.listingId],
  );
  if (!listing) return { status: 'not_found', canonicalVariantId: null, reviewCaseId: null };

  await execute(`UPDATE source_listings SET cluster_status = 'searching' WHERE id = $1`, [opts.listingId]);

  const listingIdentity: IdentityFields = {
    ...emptyIdentityFields(),
    categoryKey: listing.category_key,
    producer: listing.producer_name, producerId: listing.producer_id,
    brand: listing.brand_name, brandId: listing.brand_id,
    expression: listing.expression,
    vintageValue: listing.vintage_value,
    vintageStatus: listing.vintage_status as IdentityFields['vintageStatus'],
    ageStatementYears: listing.age_statement_years,
    volumeMl: listing.volume_ml, packCount: listing.pack_count ?? 1,
    packagingType: listing.packaging_type as IdentityFields['packagingType'],
    edition: listing.edition, caskFinish: listing.cask_finish,
    dosageStyle: listing.dosage_style, puttony: listing.puttony,
    abvPercent: listing.abv_percent, gtin: listing.gtin_normalized,
    colour: listing.colour, region: listing.region,
    grapeVarieties: listing.grape_varieties ?? [],
    grapeVarietyIds: listing.grape_ids ?? [],
    grapeSignature: listing.grape_signature,
    wineStyleId: listing.wine_style_id,
    vineyardId: listing.vineyard_id,
    wineRegionId: listing.wine_region_id,
  };

  // Kanonikus valtozat-jeloltek
  const { generateVariantCandidates } = await import('./candidates.js');
  const variantCandidates = await generateVariantCandidates({
    identity: listingIdentity,
    rawName: listing.raw_name,
    normalizedName: listing.normalized_name,
  });

  if (!variantCandidates.length) {
    await execute(`UPDATE source_listings SET cluster_status = 'unclustered' WHERE id = $1`, [opts.listingId]);
    return { status: 'no_variant_candidate', canonicalVariantId: null, reviewCaseId: null };
  }

  // Minden jelolt kanonikus valtozatot kiertekelunk a szokasos motorral,
  // de a listing az EGYETLEN jelolt oldal.
  const asCandidate: Candidate = {
    listingId: listing.id, shopId: listing.shop_id, shopKey: listing.shop_key,
    identity: listingIdentity, rawName: listing.raw_name,
    normalizedName: listing.normalized_name, identityHash: listing.identity_hash ?? '',
    extractionQuality: listing.extraction_quality ?? 0, evidence: {},
    url: listing.canonical_url,
    priceHuf: listing.price_huf,
    channels: [{ channel: 'catalog_block', rank: 1, score: 0.8 }],
  };

  let best: { decision: MatchDecisionResult; variant: VariantRow } | null = null;

  for (const candidate of variantCandidates.slice(0, 8)) {
    const variantRow = await queryOne<VariantRow>(`${VARIANT_QUERY} WHERE cv.id = $1`, [candidate.id]);
    if (!variantRow) continue;

    const profile = resolveIdentityProfile({
      categoryProfile: variantRow.category_identity_profile as never,
      categoryPolicy: variantRow.category_comparison_policy as never,
      variantProfile: Object.keys(variantRow.identity_profile_json ?? {}).length
        ? (variantRow.identity_profile_json as never) : null,
      variantPolicy: Object.keys(variantRow.comparison_policy_json ?? {}).length
        ? (variantRow.comparison_policy_json as never) : null,
    });

    const decision = decideMatch({
      canonical: canonicalSide(variantRow),
      candidates: [{ ...asCandidate, channels: [{ channel: candidate.channel, rank: 1, score: candidate.score }] }],
      profile,
      policy: opts.policy,
      comparatorCtx: {
        aliasResolver: opts.taxonomy.aliasResolver,
        negativeAliasCheck: opts.taxonomy.negativeAliasCheck,
        shopId: listing.shop_id,
      },
      sourceHealthy: true,
    });

    if (decision.status === 'rejected') continue;
    if (!best || (decision.decisionStrength ?? 0) > (best.decision.decisionStrength ?? 0)) {
      best = { decision, variant: variantRow };
    }
  }

  if (!best) {
    await execute(
      `UPDATE source_listings SET cluster_status = 'rejected_all' WHERE id = $1`, [opts.listingId],
    );
    return { status: 'all_rejected', canonicalVariantId: null, reviewCaseId: null };
  }

  const persisted = await persistDecision({
    decision: best.decision,
    variant: best.variant,
    shopId: listing.shop_id,
    shopKey: listing.shop_key,
    policy: opts.policy,
    crawlRunId: opts.crawlRunId ?? null,
    candidates: [asCandidate],
  });

  if (best.decision.status === 'auto_verified') {
    await execute(`UPDATE source_listings SET cluster_status = 'clustered' WHERE id = $1`, [opts.listingId]);
  } else if (persisted.reviewCaseId) {
    await execute(`UPDATE source_listings SET cluster_status = 'needs_review' WHERE id = $1`, [opts.listingId]);
  } else {
    await execute(`UPDATE source_listings SET cluster_status = 'unclustered' WHERE id = $1`, [opts.listingId]);
  }

  logger.info('cluster.evaluated', {
    listingId: opts.listingId,
    status: best.decision.status,
    canonicalVariantId: best.variant.id,
    strength: best.decision.decisionStrength,
  });

  return {
    status: best.decision.status,
    canonicalVariantId: best.variant.id,
    reviewCaseId: persisted.reviewCaseId,
  };
}
