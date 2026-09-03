/**
 * Bizonyitekalapu parosito motor (spec 15.).
 *
 * DONTESI ELV: a motor nem egyetlen hasonlosagi szamot szamol, hanem eloszor
 * KIZARJA a bizonyitottan hibas parokat, majd a megmaradt jeloltek
 * bizonyitekait ertekeli, es ha nem eleg eros, TARTOZKODIK.
 *
 * A "biztosan mukodo" rendszer felteteles a `nem bizonyithato` valasz
 * engedelyezese (spec 1.).
 */
import type {
  Candidate, HardContradiction, IdentityFields, MatchDecisionResult,
  MatchPolicy, MatchStatus, ScoredCandidate, CandidateChannel, FieldComparison,
} from '@radovin/contracts';
import { CHANNEL_STRENGTH, REASON_CODES, REASON_CODE_HU } from '@radovin/contracts';
import { compareIdentityFields, type ComparatorContext } from './comparators.js';
import type { ResolvedIdentityProfile } from '../identity/profile.js';

export interface CanonicalSide {
  id: string;
  displayName: string;
  identity: IdentityFields;
  /** A kanonikus oldal kinyeresi minosege (import/manual eseten 1.0). */
  extractionQuality: number;
  identityHash: string;
  /**
   * Viszonyitasi ar: a mar IGAZOLT boltok legolcsobb osszehasonlithato ara.
   * Csak az automatikus jovahagyas oreként hasznaljuk - az azonossagot nem
   * bizonyitja es nem cafolja. Ismeretlen ar eseten nincs hatasa.
   */
  referencePriceHuf?: number | null;
}

export interface EngineInput {
  canonical: CanonicalSide;
  candidates: Candidate[];
  profile: ResolvedIdentityProfile;
  policy: MatchPolicy;
  comparatorCtx: Omit<ComparatorContext, 'profile' | 'policy'>;
  /** Negativ memoria: listingId -> hany korabbi elutasitas (spec 14.3). */
  negativeHistory?: Map<string, number>;
  /** Ember altal mar igazolt kapcsolat ehhez a listinghez. */
  verifiedListingIds?: Set<string>;
  /** A forras egeszseges-e (spec 16.1). */
  sourceHealthy?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pontozas (spec 15.5)
// ═══════════════════════════════════════════════════════════════════════════

export function scoreCandidate(
  input: EngineInput,
  candidate: Candidate,
): ScoredCandidate {
  const ctx: ComparatorContext = {
    ...input.comparatorCtx,
    profile: input.profile,
    policy: input.profile.policy,
    shopId: candidate.shopId,
  };

  const cmp = compareIdentityFields(
    input.canonical.identity,
    candidate.identity,
    ctx,
    input.policy.fieldWeights,
  );

  const reasonCodes: string[] = [];
  const negativeHistory = input.negativeHistory?.get(candidate.listingId) ?? 0;

  // ── 1. Hard gate: a pontszam NEM irhatja felul (spec 38/6) ────────────────
  if (cmp.hardContradictions.length > 0) {
    return {
      candidate,
      rejected: true,
      hardContradictions: cmp.hardContradictions,
      fields: cmp.fields,
      agreementScore: 0,
      evidenceCoverage: 0,
      extractionQuality: candidate.extractionQuality,
      retrievalSupport: retrievalSupport(candidate),
      contradictionCount: cmp.hardContradictions.length,
      negativeHistory,
      decisionStrength: 0,
      topMargin: 0,
      reasonCodes: cmp.hardContradictions.map((h) => h.code),
      identityComplete: false,
      priceRatio: priceRatioOf(input.canonical, candidate),
    };
  }

  // ── 2. agreement_score: az ISMERT, osszehasonlithato mezok sulyozott egyezese
  let weightSum = 0;
  let weightedScore = 0;
  for (const f of cmp.fields) {
    if (f.role === 'not_applicable') continue;
    if (f.state === 'unknown') continue; // az unknown NEM kap egyezesi pontot
    weightSum += f.weight;
    weightedScore += f.weight * (f.score ?? (f.state === 'match' ? 1 : 0));
  }
  const agreementScore = weightSum > 0 ? weightedScore / weightSum : 0;

  // ── 3. evidence_coverage: a SZUKSEGES bizonyitekok lefedettsege ───────────
  const requiredFields = input.profile.requiredFields;
  const coverage = evidenceCoverage(cmp.fields, requiredFields);
  if (cmp.unknownRequired.length > 0) {
    for (const f of cmp.unknownRequired) reasonCodes.push(requiredUnknownCode(f));
  }
  if (coverage < input.policy.thresholds.autoMatch.evidenceCoverage) {
    reasonCodes.push(REASON_CODES.LOW_EVIDENCE_COVERAGE);
  }

  // ── 4. extraction_quality: mindket oldal gyengebbike ──────────────────────
  const extractionQuality = Math.min(candidate.extractionQuality, input.canonical.extractionQuality);
  if (extractionQuality < input.policy.thresholds.autoMatch.extractionQuality) {
    reasonCodes.push(REASON_CODES.LOW_EXTRACTION_QUALITY);
  }

  // ── 5. retrieval_support ─────────────────────────────────────────────────
  const support = retrievalSupport(candidate);

  if (cmp.fuzzyOnlyBrandMatch) reasonCodes.push(REASON_CODES.FUZZY_ONLY_BRAND_MATCH);
  if (cmp.shopSpecificAliasOnly) reasonCodes.push(REASON_CODES.SHOP_SPECIFIC_ALIAS_ONLY);
  if (negativeHistory > 0) reasonCodes.push(REASON_CODES.NEGATIVE_HISTORY);

  // EAN egyezik, de a vintage nem bizonyitott (spec 15.6, 10.2)
  const gtinField = cmp.fields.find((f) => f.field === 'gtin');
  const vintageField = cmp.fields.find((f) => f.field === 'vintage');
  if (
    gtinField?.state === 'match' &&
    vintageField?.state === 'unknown' &&
    input.profile.isVintageSensitive() &&
    !input.profile.gtinResolvesVintage()
  ) {
    reasonCodes.push(REASON_CODES.EAN_MATCH_VINTAGE_UNPROVEN);
  }

  // ── 5b. Arany-or ─────────────────────────────────────────────────────────
  //
  // Az ar SOHA nem utasit el es nem is javit a pontszamon: a rendszer termeke
  // epp az arkulonbseg, egy valodi 30%-os elonyt eldobni onveszelyes lenne.
  // Amit tud: egy kiugro arany (a belepo es a premium tetel ugyanattol a
  // boraszattol sokszorosan elter) megallitja az AUTOMATIKUS jovahagyast, es
  // emberi dontesre teszi a part.
  const priceRatio = priceRatioOf(input.canonical, candidate);
  if (priceRatio !== null && priceRatio > input.policy.thresholds.priceRatioMax) {
    reasonCodes.push(REASON_CODES.PRICE_RATIO_IMPLAUSIBLE);
  }

  // ── 6. decision_strength: az osszevont dontesi ero ────────────────────────
  const decisionStrength = clamp01(
    0.50 * agreementScore +
    0.22 * coverage +
    0.16 * extractionQuality +
    0.12 * support -
    0.10 * Math.min(negativeHistory, 3) / 3,
  );

  return {
    candidate,
    rejected: false,
    hardContradictions: [],
    fields: cmp.fields,
    agreementScore: round4(agreementScore),
    evidenceCoverage: round4(coverage),
    extractionQuality: round4(extractionQuality),
    retrievalSupport: round4(support),
    contradictionCount: 0,
    negativeHistory,
    decisionStrength: round4(decisionStrength),
    topMargin: 0,
    reasonCodes: [...new Set(reasonCodes)],
    identityComplete: cmp.identityComplete,
    priceRatio,
  };
}

/**
 * A ket ar hanyadosa, ha MINDKETTO ismert.
 *
 * A hianyzo ar nem gyanu: egy keszlethiany vagy egy kinyeresi hiba miatt
 * ismeretlen ar nem tehet gyanussa egy egyebkent bizonyitott azonossagot.
 * A kanonikus oldal ara a mar igazolt listingek kozul a legolcsobb.
 */
function priceRatioOf(canonical: CanonicalSide, candidate: Candidate): number | null {
  const a = canonical.referencePriceHuf ?? null;
  const b = candidate.priceHuf ?? null;
  if (!a || !b || a <= 0 || b <= 0) return null;
  return round4(Math.max(a, b) / Math.min(a, b));
}

function requiredUnknownCode(field: string): string {
  switch (field) {
    case 'vintage':
    case 'vintageValue': return REASON_CODES.REQUIRED_VINTAGE_UNKNOWN;
    case 'volumeMl': return REASON_CODES.REQUIRED_VOLUME_UNKNOWN;
    case 'producer': return REASON_CODES.REQUIRED_PRODUCER_UNKNOWN;
    case 'expression': return REASON_CODES.REQUIRED_EXPRESSION_UNKNOWN;
    default: return REASON_CODES.REQUIRED_FIELD_UNKNOWN;
  }
}

/**
 * evidence_coverage: a SZUKSEGES bizonyitekok lefedettsege (spec 15.5).
 *
 * A `required` mezoknel minden hiany szamit. Az opcionalis mezoknel viszont
 * csak akkor van mit bizonyitani, ha legalabb az EGYIK oldal ismeri az
 * erteket - ha egyik forras sem emliti (pl. a bornak nincs feltuntetett
 * hordoerlelese), az nem hianyzo bizonyitek, hanem nem letezo attributum.
 * Ezert az ilyen mezo kiesik a nevezobol.
 */
function evidenceCoverage(fields: FieldComparison[], requiredFields: string[]): number {
  const required = new Set(requiredFields.map((f) => (f === 'vintageValue' ? 'vintage' : f)));
  let requiredKnown = 0;
  let requiredTotal = 0;
  let optionalKnown = 0;
  let optionalTotal = 0;

  const present = (v: unknown) =>
    v !== null && v !== undefined && v !== '' && v !== 'unknown' &&
    !(Array.isArray(v) && v.length === 0);

  for (const f of fields) {
    if (f.role === 'not_applicable') continue;
    const isRequired = f.role === 'required' || required.has(f.field);
    if (isRequired) {
      requiredTotal++;
      if (f.state !== 'unknown') requiredKnown++;
      continue;
    }
    // Opcionalis mezo: csak akkor szamit, ha valamelyik oldal allit rola valamit.
    if (!present(f.leftValue) && !present(f.rightValue)) continue;
    optionalTotal++;
    if (f.state !== 'unknown') optionalKnown++;
  }

  if (requiredTotal === 0) return optionalTotal ? optionalKnown / optionalTotal : 0;
  const req = requiredKnown / requiredTotal;
  const opt = optionalTotal ? optionalKnown / optionalTotal : 1;
  // A kotelezo mezok sulya dominal
  return clamp01(0.85 * req + 0.15 * opt);
}

function retrievalSupport(candidate: Candidate): number {
  if (!candidate.channels.length) return 0;
  // A legerosebb csatorna dominal, a tobbi kis bonuszt ad.
  const strengths = candidate.channels
    .map((c) => CHANNEL_STRENGTH[c.channel] ?? 0.3)
    .sort((a, b) => b - a);
  const best = strengths[0] ?? 0;
  const extra = strengths.slice(1).reduce((acc, s) => acc + s * 0.08, 0);
  return clamp01(best + Math.min(extra, 0.15));
}

// ═══════════════════════════════════════════════════════════════════════════
// Dontes (spec 15.6, 15.9)
// ═══════════════════════════════════════════════════════════════════════════

export function decideMatch(input: EngineInput): MatchDecisionResult {
  const { canonical, policy, profile } = input;

  const evaluated = input.candidates.map((c) => scoreCandidate(input, c));
  const eligible = evaluated
    .filter((e) => !e.rejected)
    .sort((a, b) => b.decisionStrength - a.decisionStrength);

  const allChannels = [
    ...new Set(input.candidates.flatMap((c) => c.channels.map((ch) => ch.channel))),
  ] as CandidateChannel[];

  const runnerUp = evaluated
    .slice()
    .sort((a, b) => b.decisionStrength - a.decisionStrength)
    .slice(0, 5)
    .map((e) => ({
      listingId: e.candidate.listingId,
      shopKey: e.candidate.shopKey,
      rawName: e.candidate.rawName,
      url: e.candidate.url,
      decisionStrength: e.decisionStrength,
      rejected: e.rejected,
      reasonCodes: e.reasonCodes,
    }));

  // ── Nincs jelolt ─────────────────────────────────────────────────────────
  if (input.candidates.length === 0) {
    return baseDecision(canonical, null, policy, {
      status: input.sourceHealthy === false ? 'source_unhealthy' : 'not_found_after_full_search',
      reasonCodes: [input.sourceHealthy === false ? REASON_CODES.SOURCE_UNHEALTHY : REASON_CODES.NO_CANDIDATE],
      explanationHu: input.sourceHealthy === false
        ? 'A forras technikai allapota miatt nem vonhato le uzleti kovetkeztetes.'
        : 'A teljes keresesi terv lefutott, de egyetlen jelolt sem keletkezett.',
      candidateSources: allChannels,
      runnerUp,
    });
  }

  // ── Minden jelolt kiesett hard contradictionon ───────────────────────────
  if (eligible.length === 0) {
    // A LEGKOZELEBBI kozelites jelentendo, nem a bemeneti sorrend elso eleme.
    // A pontszam mind a nullaval egyenlo (a hard gate nullazza), ezert a
    // kevesebb ellentmondas, azon belul az erosebb visszakeresesi tamogatas
    // dont. Enelkul az ember egy onkenyesen kivalasztott jelolt indoklasat
    // latna - pont azt, ami a dontesehez a legkevesbe hasznos.
    const first = [...evaluated].sort(
      (a, b) => a.contradictionCount - b.contradictionCount
        || b.retrievalSupport - a.retrievalSupport,
    )[0];
    return baseDecision(canonical, first?.candidate ?? null, policy, {
      status: 'rejected',
      hardContradictions: first?.hardContradictions ?? [],
      fieldResults: fieldResultsOf(first),
      contradictionCount: first?.contradictionCount ?? 0,
      reasonCodes: [...new Set(evaluated.flatMap((e) => e.reasonCodes))],
      explanationHu: 'Minden jelolt kizaro ellentmondas miatt kiesett.',
      candidateSources: allChannels,
      runnerUp,
    });
  }

  const first = eligible[0]!;
  const second = eligible[1];
  first.topMargin = second ? round4(first.decisionStrength - second.decisionStrength) : 1;

  const reasons = new Set(first.reasonCodes);

  // ── Ember altal igazolt kapcsolat vedelme (spec 17.4) ────────────────────
  if (input.verifiedListingIds?.has(first.candidate.listingId)) {
    return baseDecision(canonical, first.candidate, policy, {
      status: 'human_verified',
      fieldResults: fieldResultsOf(first),
      scores: first,
      reasonCodes: [...reasons],
      explanationHu: 'Ember altal jovahagyott kapcsolat, identitas-drift nelkul.',
      candidateSources: allChannels,
      runnerUp,
    });
  }

  // ── Automatikus dontesi politika (spec 15.6) ─────────────────────────────
  const th = policy.thresholds.autoMatch;
  const hasAllRequired = first.fields
    .filter((f) => f.role === 'required')
    .every((f) => f.state === 'match');

  const strongIdentifier = first.candidate.channels.some(
    (c) => c.channel === 'gtin' || c.channel === 'platform_id' || c.channel === 'verified_link',
  ) && first.fields.some((f) => f.field === 'gtin' && f.state === 'match');

  const autoEligible =
    policy.autoMatchEnabled &&
    !profile.autoMatchBlocked() &&
    first.contradictionCount === 0 &&
    hasAllRequired &&
    first.evidenceCoverage >= th.evidenceCoverage &&
    first.extractionQuality >= th.extractionQuality &&
    first.agreementScore >= th.agreementScore &&
    first.topMargin >= th.topMargin &&
    !reasons.has(REASON_CODES.FUZZY_ONLY_BRAND_MATCH) &&
    !reasons.has(REASON_CODES.AI_SUGGESTION_ONLY) &&
    !reasons.has(REASON_CODES.EAN_MATCH_VINTAGE_UNPROVEN) &&
    first.negativeHistory === 0 &&
    (!policy.autoMatchIdentifierOnly || strongIdentifier);

  // ── Masodik ut: TELJES bizonyitott azonossag ─────────────────────────────
  //
  // Az elso ut bornal soha nem tud tuzelni. Ket oka van: a GTIN-feltetel
  // (`autoMatchIdentifierOnly`) ertelmetlen, mert ugyanaz az EAN tobb
  // evjaratot is atfog - ezert mondja ki a bor profilja, hogy
  // `gtinResolvesVintage: false` -, es a `extractionQuality >= 0.90` kuszob
  // is teljesithetetlen a valos webshopadatokon.
  //
  // Ez az ut mast kerdez: nem azt, hogy MENNYIRE eros a bizonyitas, hanem
  // hogy TELJES-e. Ha minden azonossaghordozo - boraszat, fajta, bortipus,
  // evjarat, kiszereles - bizonyitottan egyezik, es semmi nem mond ellent,
  // akkor nem maradt olyan kerdes, amit egy ember jobban tudna eldonteni.
  //
  // Ezert kerulheti meg a pontszam-kuszoboket: a teljesseg celzottabb es
  // szigorubb teszt, mint a minosegi padlo. Egy gyenge kinyeresu listing
  // azonossagmezoi ugyis `unknown`-ok maradnak, tehat itt eleve elbukik.
  const identityCompleteEligible =
    policy.autoMatchIdentityComplete &&
    !profile.autoMatchBlocked() &&
    first.identityComplete &&
    first.contradictionCount === 0 &&
    !reasons.has(REASON_CODES.FUZZY_ONLY_BRAND_MATCH) &&
    !reasons.has(REASON_CODES.SHOP_SPECIFIC_ALIAS_ONLY) &&
    !reasons.has(REASON_CODES.PRICE_RATIO_IMPLAUSIBLE) &&
    first.negativeHistory === 0 &&
    first.topMargin >= th.topMargin;

  if (identityCompleteEligible) {
    reasons.add(REASON_CODES.IDENTITY_COMPLETE);
    return baseDecision(canonical, first.candidate, policy, {
      status: 'auto_verified',
      fieldResults: fieldResultsOf(first),
      scores: first,
      reasonCodes: [...reasons],
      explanationHu: buildExplanation(first, 'auto'),
      candidateSources: allChannels,
      runnerUp,
    });
  }

  if (autoEligible) {
    return baseDecision(canonical, first.candidate, policy, {
      status: 'auto_verified',
      fieldResults: fieldResultsOf(first),
      scores: first,
      reasonCodes: [...reasons],
      explanationHu: buildExplanation(first, 'auto'),
      candidateSources: allChannels,
      runnerUp,
    });
  }

  // Miert nem lett automatikus?
  //
  // Az `AUTO_MATCH_DISABLED` csak akkor igaz allitas, ha MINDKET ut zarva
  // van. Ha a teljes-azonossagi ut nyitva all, es a par megis nem ment at,
  // akkor nem a kapcsolo volt az ok - es ezt kiirni felrevezetne azt, aki
  // az indoklas alapjan probal donteni.
  const bothAutoPathsClosed = !policy.autoMatchEnabled && !policy.autoMatchIdentityComplete;
  if (bothAutoPathsClosed) reasons.add(REASON_CODES.AUTO_MATCH_DISABLED);
  else if (policy.autoMatchEnabled && policy.autoMatchIdentifierOnly && !strongIdentifier) {
    reasons.add(REASON_CODES.AUTO_MATCH_IDENTIFIER_ONLY);
  }
  if (profile.autoMatchBlocked()) reasons.add(REASON_CODES.CATEGORY_AUTOMATCH_BLOCKED);

  // ── Ambiguous: tobb egyformán eros jelolt ────────────────────────────────
  if (second && first.topMargin < policy.thresholds.ambiguousMargin && first.decisionStrength >= policy.thresholds.review.minScore) {
    reasons.add(REASON_CODES.MULTIPLE_SIMILAR_VARIANTS);
    reasons.add(REASON_CODES.SMALL_TOP_MARGIN);
    return baseDecision(canonical, first.candidate, policy, {
      status: 'ambiguous',
      fieldResults: fieldResultsOf(first),
      scores: first,
      reasonCodes: [...reasons],
      explanationHu: `Ket vagy tobb jelolt gyakorlatilag azonos erosseggel szerepel (kulonbseg: ${first.topMargin}).`,
      candidateSources: allChannels,
      runnerUp,
    });
  }

  // ── Review: van eleg eros jelolt, de hianyzik bizonyitek ────────────────
  if (first.decisionStrength >= policy.thresholds.review.minScore) {
    if (first.topMargin < th.topMargin) reasons.add(REASON_CODES.SMALL_TOP_MARGIN);
    return baseDecision(canonical, first.candidate, policy, {
      status: 'needs_review',
      fieldResults: fieldResultsOf(first),
      scores: first,
      reasonCodes: [...reasons],
      explanationHu: buildExplanation(first, 'review'),
      candidateSources: allChannels,
      runnerUp,
    });
  }

  // ── Nem bizonyithato ────────────────────────────────────────────────────
  return baseDecision(canonical, first.candidate, policy, {
    status: 'insufficient_evidence',
    fieldResults: fieldResultsOf(first),
    scores: first,
    reasonCodes: [...reasons],
    explanationHu: `A legjobb jelolt dontesi erossege ${first.decisionStrength}, ami nem eri el a felulvizsgalati kuszobot (${policy.thresholds.review.minScore}).`,
    candidateSources: allChannels,
    runnerUp,
  });
}

// ── Segedek ────────────────────────────────────────────────────────────────

function fieldResultsOf(sc: ScoredCandidate | undefined): MatchDecisionResult['fieldResults'] {
  const out: MatchDecisionResult['fieldResults'] = {};
  if (!sc) return out;
  for (const f of sc.fields) {
    out[f.field] = {
      state: f.state, score: f.score, role: f.role,
      leftValue: f.leftValue, rightValue: f.rightValue,
    };
  }
  return out;
}

interface BaseDecisionOpts {
  status: MatchStatus;
  hardContradictions?: HardContradiction[];
  fieldResults?: MatchDecisionResult['fieldResults'];
  scores?: ScoredCandidate;
  contradictionCount?: number;
  reasonCodes: string[];
  explanationHu: string;
  candidateSources: CandidateChannel[];
  runnerUp: MatchDecisionResult['runnerUp'];
}

function baseDecision(
  canonical: CanonicalSide,
  candidate: Candidate | null,
  policy: MatchPolicy,
  o: BaseDecisionOpts,
): MatchDecisionResult {
  return {
    canonicalVariantId: canonical.id,
    sourceListingId: candidate?.listingId ?? null,
    shopId: candidate?.shopId ?? null,
    status: o.status,
    matcherVersion: policy.matcherVersion,
    taxonomyVersion: policy.taxonomyVersion,
    policyVersion: policy.policyVersion,
    hardContradictions: o.hardContradictions ?? o.scores?.hardContradictions ?? [],
    fieldResults: o.fieldResults ?? {},
    agreementScore: o.scores?.agreementScore ?? null,
    evidenceCoverage: o.scores?.evidenceCoverage ?? null,
    extractionQuality: o.scores?.extractionQuality ?? null,
    retrievalSupport: o.scores?.retrievalSupport ?? null,
    topMargin: o.scores?.topMargin ?? null,
    decisionStrength: o.scores?.decisionStrength ?? null,
    identityComplete: o.scores?.identityComplete ?? false,
    priceRatio: o.scores?.priceRatio ?? null,
    contradictionCount: o.contradictionCount ?? o.scores?.contradictionCount ?? 0,
    negativeHistory: o.scores?.negativeHistory ?? 0,
    reasonCodes: [...new Set(o.reasonCodes)],
    explanationHu: o.explanationHu,
    candidateSources: o.candidateSources,
    runnerUp: o.runnerUp,
    decidedBy: 'engine',
  };
}

function buildExplanation(sc: ScoredCandidate, mode: 'auto' | 'review'): string {
  const matched = sc.fields.filter((f) => f.state === 'match').map((f) => f.field);
  const unknown = sc.fields.filter((f) => f.state === 'unknown' && f.role === 'required').map((f) => f.field);
  const parts: string[] = [];
  if (sc.identityComplete) {
    parts.push('Minden azonossaghordozo mezo bizonyitottan egyezik.');
  }
  if (matched.length) parts.push(`Egyezo mezok: ${matched.join(', ')}.`);
  if (unknown.length) parts.push(`Nem bizonyitott kotelezo mezok: ${unknown.join(', ')}.`);
  if (sc.priceRatio !== null && sc.priceRatio > 1.25) {
    parts.push(`Az arak aranya: ${sc.priceRatio}x.`);
  }
  parts.push(
    `Pontszamok - egyezes: ${sc.agreementScore}, bizonyitek-lefedettseg: ${sc.evidenceCoverage}, ` +
    `kinyeresi minoseg: ${sc.extractionQuality}, elony a masodikhoz kepest: ${sc.topMargin}.`,
  );
  if (mode === 'review' && sc.reasonCodes.length) {
    parts.push(`Felulvizsgalati okok: ${sc.reasonCodes.map((c) => REASON_CODE_HU[c] ?? c).join('; ')}.`);
  }
  return parts.join(' ');
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
