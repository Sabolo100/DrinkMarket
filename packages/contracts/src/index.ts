/**
 * Közös típusszerződések. Minden réteg (adapter, extraction, matching, API,
 * frontend) ezeket használja. Belső mező- és API-nevek angolul (spec bevezető).
 */

// ═══════════════════════════════════════════════════════════════════════════
// Státuszok (spec 20.)
// ═══════════════════════════════════════════════════════════════════════════

export type SourceStatus =
  | 'ok' | 'partial' | 'blocked' | 'rate_limited' | 'timeout'
  | 'unavailable' | 'parse_error' | 'catalog_regression' | 'policy_disabled';

export type ObservationStatus =
  | 'observed' | 'out_of_stock' | 'not_orderable' | 'missing' | 'redirected'
  | 'invalid_price' | 'identity_drift' | 'extraction_incomplete';

export type MatchStatus =
  | 'unsearched' | 'searching' | 'candidate_found' | 'needs_review'
  | 'auto_verified' | 'human_verified' | 'rejected' | 'ambiguous'
  | 'insufficient_evidence' | 'not_found_after_full_search'
  | 'source_unhealthy' | 'mapping_drift' | 'listing_missing' | 'suspended';

export type VariantShopStatus = MatchStatus | 'search_incomplete';

export type ListingStatus = 'active' | 'missing' | 'redirected' | 'archived' | 'blocked' | 'not_product';
export type ClusterStatus = 'unclustered' | 'searching' | 'clustered' | 'needs_review' | 'rejected_all' | 'drifted';
export type AvailabilityStatus = 'in_stock' | 'out_of_stock' | 'preorder' | 'backorder' | 'discontinued' | 'unknown';
export type VintageStatus = 'vintage' | 'non_vintage' | 'not_applicable' | 'unknown';
export type PackagingType = 'unknown' | 'standard' | 'gift_box' | 'wooden_case' | 'carton' | 'tube' | 'set' | 'tin';
export type PriceType = 'regular' | 'sale' | 'member' | 'coupon' | 'quantity' | 'unknown' | 'not_comparable';

export type UserRole = 'viewer' | 'reviewer' | 'catalog_manager' | 'source_manager' | 'admin';

export const ROLE_RANK: Record<UserRole, number> = {
  viewer: 10, reviewer: 20, catalog_manager: 30, source_manager: 30, admin: 100,
};

// ═══════════════════════════════════════════════════════════════════════════
// Evidence (spec 12.2) — minden kinyert mező bizonyítékkötött
// ═══════════════════════════════════════════════════════════════════════════

export type ExtractionMethod =
  | 'platform_api' | 'jsonld' | 'app_state' | 'microdata' | 'meta'
  | 'spec_table' | 'dom' | 'title' | 'description' | 'breadcrumb'
  | 'regex' | 'taxonomy' | 'url' | 'ocr' | 'ai' | 'human' | 'import' | 'derived';

/** A módszerek megbízhatósági rangsora (spec 12.1). Nagyobb = erősebb. */
export const METHOD_STRENGTH: Record<ExtractionMethod, number> = {
  platform_api: 1.00, jsonld: 0.97, app_state: 0.93, microdata: 0.88, meta: 0.82,
  spec_table: 0.85, dom: 0.72, title: 0.62, description: 0.45, breadcrumb: 0.55,
  regex: 0.60, taxonomy: 0.70, url: 0.30, ocr: 0.40, ai: 0.55,
  human: 1.00, import: 0.65, derived: 0.50,
};

export interface Evidence<T = unknown> {
  field: string;
  normalized_value: T;
  raw_value: string | null;
  source_location: string;
  source_excerpt: string | null;
  method: ExtractionMethod;
  confidence: number;
  observed_at: string;
  /** AI esetén kötelező: melyik prompt/modell adta. */
  model?: string;
  prompt_version?: string;
}

export type EvidenceMap = Record<string, Evidence>;

// ═══════════════════════════════════════════════════════════════════════════
// Identitás (spec 10., 13.)
// ═══════════════════════════════════════════════════════════════════════════

/** A háromállapotú mező-összehasonlítás eredménye (spec 15.2). */
export type FieldState = 'match' | 'contradiction' | 'unknown';

export type IdentityFieldRole = 'required' | 'contradiction_only' | 'supporting' | 'not_applicable';

export interface IdentityProfile {
  required: string[];
  contradiction_only: string[];
  supporting: string[];
  not_applicable: string[];
  /** Vintage-érzékeny kategória (bor, pezsgő): eltérő évjárat kizáró ok. */
  vintageSensitive: boolean;
  /** Feloldhatja-e a GTIN-egyezés az évjáratot? Bornál SOHA (spec 10.2). */
  gtinResolvesVintage: boolean;
  notes?: string;
}

export interface ComparisonPolicy {
  /** Díszdoboz elfogadható-e azonos eladható változatként? Alapból NEM. */
  giftBoxEquivalent: boolean;
  volumeToleranceMl: number;
  packMustMatch: boolean;
  allowedPriceTypes: PriceType[];
  freshnessMaxHours: number;
  requireInStock: boolean;
  autoMatchBlocked?: boolean;
  /** Termékspecifikus, indokolt kivétel (spec 3.1). */
  exceptionReason?: string;
  exceptionApprovedBy?: string;
}

/** A normalizált, összehasonlítható identitásmezők halmaza. */
export interface IdentityFields {
  categoryKey: string | null;
  producer: string | null;
  producerId: string | null;
  brand: string | null;
  brandId: string | null;
  expression: string | null;
  vintageValue: number | null;
  vintageStatus: VintageStatus;
  ageStatementYears: number | null;
  volumeMl: number | null;
  packCount: number;
  packagingType: PackagingType;
  containerType: string | null;
  edition: string | null;
  caskFinish: string | null;
  dosageStyle: string | null;
  sweetness: string | null;
  puttony: number | null;
  abvPercent: number | null;
  colour: string | null;
  region: string | null;
  countryCode: string | null;
  grapeVarieties: string[];
  gtin: string | null;
  sku: string | null;
  flavour: string | null;
  fruit: string | null;
  aging: string | null;
  subcategory: string | null;
  appellation: string | null;
  vineyard: string | null;
  organic: boolean | null;

  // ── Bor-szotarra feloldott azonossaghordozok (0010 migracio) ────────────
  // A szoveges parjaik (grapeVarieties, colour, region, vineyard) megmaradnak
  // megjelenitesre; az AZONOSSAG viszont ezeken az azonositokon dol el, mert
  // csak igy oldodik fel az "Olaszrizling" = "Welschriesling" szinonimapar.
  /** Feloldott szolofajta-azonositok. Ures tomb = nem ismert. */
  grapeVarietyIds: string[];
  /** A rendezett fajtahalmaz stabil lenyomata (lasd grapeSignature()). */
  grapeSignature: string | null;
  wineStyleId: string | null;
  wineStyle: string | null;
  vineyardId: string | null;
  wineRegionId: string | null;
}

export function emptyIdentityFields(): IdentityFields {
  return {
    categoryKey: null, producer: null, producerId: null, brand: null, brandId: null,
    expression: null, vintageValue: null, vintageStatus: 'unknown', ageStatementYears: null,
    volumeMl: null, packCount: 1, packagingType: 'unknown', containerType: null,
    edition: null, caskFinish: null, dosageStyle: null, sweetness: null, puttony: null,
    abvPercent: null, colour: null, region: null, countryCode: null, grapeVarieties: [],
    grapeVarietyIds: [], grapeSignature: null, wineStyleId: null, wineStyle: null,
    vineyardId: null, wineRegionId: null,
    gtin: null, sku: null, flavour: null, fruit: null, aging: null, subcategory: null,
    appellation: null, vineyard: null, organic: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Adapter-szerződés (spec 11.3)
// ═══════════════════════════════════════════════════════════════════════════

export interface ShopConfig {
  id: string;
  key: string;
  name: string;
  baseUrl: string;
  canonicalHost: string;
  alternateHosts: string[];
  segment: 'wine' | 'spirit' | 'mixed';
  adapterKey: string;
  adapterVersion: string;
  adapterConfig: Record<string, unknown>;
  discoveryStrategy: string;
  policyDisabled: boolean;
  crawlPolicy: CrawlPolicy;
}

export interface CrawlPolicy {
  key: string;
  userAgent: string | null;
  requestsPerSecond: number;
  maxConcurrency: number;
  requestTimeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  respectRobots: boolean;
  allowBrowser: boolean;
  dailyRequestBudget: number | null;
}

export interface AdapterContext {
  shop: ShopConfig;
  runId: string;
  correlationId: string;
  /** HTTP letöltő, rate limittel, robots ellenőrzéssel, SSRF védelemmel. */
  fetch: FetchFn;
  /** Böngészős letöltés. Csak ha a policy engedi és nincs statikus út. */
  fetchWithBrowser?: FetchFn;
  now: () => Date;
  signal?: AbortSignal;
  /** Diagnosztikai számlálók növelése. */
  count: (key: string, by?: number) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Nyers artefakt mentése hiba/review esetén, kulcsot ad vissza. */
  saveArtifact?: (name: string, content: string | Buffer, contentType: string) => Promise<string>;
  limits: { maxPages: number; maxUrls: number; maxDurationMs: number };
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
  redirectChain: string[];
  headers: Record<string, string>;
  body: string;
  contentType: string;
  fromCache: boolean;
  timingMs: number;
  /** Blokkolás / challenge / age gate felismerése (spec 11.4). */
  guard: GuardVerdict;
}

export interface GuardVerdict {
  blocked: boolean;
  reason: 'ok' | 'challenge' | 'age_gate' | 'login_required' | 'soft_404' | 'empty_shell' | 'rate_limited' | 'robots_disallow';
  detail?: string;
}

export type FetchFn = (url: string, init?: FetchInit) => Promise<FetchResponse>;

export interface FetchInit {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  acceptJson?: boolean;
  /** Feltételes kérés (spec 11.5). */
  etag?: string | null;
  lastModified?: string | null;
  /** Böngészős módban: mire várjon. */
  waitForSelector?: string;
}

export interface HealthResult {
  healthy: boolean;
  status: SourceStatus;
  checks: Array<{ name: string; passed: boolean; detail?: string; durationMs?: number }>;
  detectedPlatform?: string;
  robotsAllows?: boolean;
  sampleProductUrl?: string;
  message?: string;
}

export interface DiscoveredTarget {
  url: string;
  platformProductId?: string;
  platformVariantId?: string;
  /** Ha a discovery már teljes terméket adott (feed/API), nem kell detail fetch. */
  inlineListing?: NormalizedSourceListing;
  hints?: Record<string, unknown>;
}

export interface DiscoveryResult {
  status: SourceStatus;
  targets: DiscoveredTarget[];
  diagnostics: AdapterDiagnostics;
  /** Bizonyíték arra, hogy a katalógus teljes-e (spec 16.1). */
  completeness: 'complete' | 'partial' | 'unknown';
  completenessEvidence: string[];
  catalogHash?: string;
}

export interface AdapterDiagnostics {
  requestsAttempted: number;
  requestsSucceeded: number;
  requestsFailed: number;
  requestsRetried: number;
  rateLimitHits: number;
  pagesSeen: number;
  urlsDiscovered: number;
  urlsDuplicate: number;
  httpStatusCounts: Record<string, number>;
  redirects: number;
  durationMs: number;
  browserUsed: boolean;
  browserTimeMs?: number;
  robotsDecision?: string;
  adapterKey: string;
  adapterVersion: string;
  notes: string[];
  errors: Array<{ code: string; message: string; url?: string }>;
}

export function emptyDiagnostics(adapterKey: string, adapterVersion: string): AdapterDiagnostics {
  return {
    requestsAttempted: 0, requestsSucceeded: 0, requestsFailed: 0, requestsRetried: 0,
    rateLimitHits: 0, pagesSeen: 0, urlsDiscovered: 0, urlsDuplicate: 0,
    httpStatusCounts: {}, redirects: 0, durationMs: 0, browserUsed: false,
    adapterKey, adapterVersion, notes: [], errors: [],
  };
}

export type ExtractStatus = 'ok' | 'not_product' | 'blocked' | 'timeout' | 'parse_error' | 'unavailable';

export interface ExtractResult {
  status: ExtractStatus;
  listing?: NormalizedSourceListing;
  diagnostics: Partial<AdapterDiagnostics> & { adapterKey: string; adapterVersion: string };
  evidence: EvidenceMap;
  rawArtifact?: { content: string; contentType: string };
}

/** Az adapter EGYSÉGES kimeneti szerződése. Adapter nem párosít (spec 38/5). */
export interface NormalizedSourceListing {
  shopKey: string;
  canonicalUrl: string;
  urlKey: string;
  finalUrl?: string;
  redirectChain?: string[];
  platformProductId?: string | null;
  platformVariantId?: string | null;
  sku?: string | null;
  gtin?: string | null;
  rawName: string;
  rawBrand?: string | null;
  rawCategoryPath?: string[];
  imageUrl?: string | null;
  descriptionExcerpt?: string | null;
  identity: IdentityFields;
  price: PriceSnapshot;
  availabilityStatus: AvailabilityStatus;
  evidence: EvidenceMap;
  extractionQuality: number;
  extractorKey: string;
  extractorVersion: string;
  extractionMethod: ExtractionMethod;
  parseWarnings: string[];
  contentHash: string;
  identityHash: string;
  sourceFingerprint: string;
  aiUsed?: boolean;
}

/** Külön ártípusok (spec 12.3). Minden érték egész HUF. */
export interface PriceSnapshot {
  currency: string;
  sourceMinorUnit: number;
  rawPriceValue: string | null;
  regularPriceHuf: number | null;
  salePriceHuf: number | null;
  currentPriceHuf: number | null;
  memberPriceHuf: number | null;
  couponPriceHuf: number | null;
  quantityPriceHuf: number | null;
  unitPriceHuf: number | null;
  unitBasis: string | null;
  depositAmountHuf: number | null;
  vatIncluded: boolean | null;
  inStock: boolean | null;
  availabilityRaw: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** A comparison policy szerint kiválasztott, összehasonlítható ár. */
  selectedComparablePriceHuf: number | null;
  priceType: PriceType;
  comparable: boolean;
  notComparableReason: string | null;
  anomalyFlags: string[];
}

export function emptyPriceSnapshot(): PriceSnapshot {
  return {
    currency: 'HUF', sourceMinorUnit: 0, rawPriceValue: null,
    regularPriceHuf: null, salePriceHuf: null, currentPriceHuf: null,
    memberPriceHuf: null, couponPriceHuf: null, quantityPriceHuf: null,
    unitPriceHuf: null, unitBasis: null, depositAmountHuf: null,
    vatIncluded: null, inStock: null, availabilityRaw: null,
    validFrom: null, validTo: null, selectedComparablePriceHuf: null,
    priceType: 'unknown', comparable: false, notComparableReason: null, anomalyFlags: [],
  };
}

export interface SearchQuery {
  text: string;
  level: number;
  limit?: number;
}

export interface SearchResult {
  status: SourceStatus;
  targets: DiscoveredTarget[];
  diagnostics: Partial<AdapterDiagnostics>;
}

export interface ShopAdapter {
  key: string;
  version: string;
  /** Milyen felderítési utakat támogat, prioritási sorrendben (spec 11.2). */
  capabilities: {
    feed: boolean;
    platformApi: boolean;
    sitemap: boolean;
    categoryPages: boolean;
    internalSearch: boolean;
    requiresBrowser: boolean;
  };
  healthCheck(ctx: AdapterContext): Promise<HealthResult>;
  discover(ctx: AdapterContext): Promise<DiscoveryResult>;
  extractListing(ctx: AdapterContext, target: DiscoveredTarget): Promise<ExtractResult>;
  search?(ctx: AdapterContext, query: SearchQuery): Promise<SearchResult>;
  refreshKnownListing(ctx: AdapterContext, listing: KnownListingRef): Promise<ExtractResult>;
  /** Forrásonként egyedi URL-kanonizálás. Query param NEM törölhető vakon. */
  canonicalizeUrl(url: string): string;
}

export interface KnownListingRef {
  id: string;
  canonicalUrl: string;
  finalUrl: string | null;
  platformProductId: string | null;
  platformVariantId: string | null;
  sku: string | null;
  urlKey: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Matching (spec 14., 15.)
// ═══════════════════════════════════════════════════════════════════════════

export type CandidateChannel =
  | 'verified_link' | 'platform_id' | 'gtin' | 'sku'
  | 'catalog_block' | 'fts' | 'trigram' | 'word_similarity'
  | 'alias' | 'embedding' | 'internal_search' | 'external_search' | 'manual_url';

/** Csatornánkénti alap-erősség a retrieval_support számításához. */
export const CHANNEL_STRENGTH: Record<CandidateChannel, number> = {
  verified_link: 1.00, platform_id: 0.95, gtin: 0.90, sku: 0.75,
  catalog_block: 0.70, fts: 0.50, trigram: 0.45, word_similarity: 0.40,
  alias: 0.65, embedding: 0.35, internal_search: 0.55, external_search: 0.30,
  manual_url: 1.00,
};

export interface Candidate {
  listingId: string;
  shopId: string;
  shopKey: string;
  identity: IdentityFields;
  rawName: string;
  normalizedName: string;
  identityHash: string;
  extractionQuality: number;
  evidence: EvidenceMap;
  url: string;
  imageUrl?: string | null;
  priceHuf?: number | null;
  channels: Array<{ channel: CandidateChannel; rank: number; score: number }>;
}

export interface FieldComparison {
  field: string;
  role: IdentityFieldRole;
  state: FieldState;
  isHard: boolean;
  leftValue: unknown;
  rightValue: unknown;
  score: number | null;
  weight: number;
  reason?: string;
}

export interface HardContradiction {
  field: string;
  code: string;
  leftValue: unknown;
  rightValue: unknown;
  message: string;
}

export interface ScoredCandidate {
  candidate: Candidate;
  rejected: boolean;
  hardContradictions: HardContradiction[];
  fields: FieldComparison[];
  agreementScore: number;
  evidenceCoverage: number;
  extractionQuality: number;
  retrievalSupport: number;
  contradictionCount: number;
  negativeHistory: number;
  decisionStrength: number;
  topMargin: number;
  reasonCodes: string[];
}

export interface MatchDecisionResult {
  canonicalVariantId: string;
  sourceListingId: string | null;
  shopId: string | null;
  status: MatchStatus;
  matcherVersion: string;
  taxonomyVersion: string;
  policyVersion: string;
  hardContradictions: HardContradiction[];
  /**
   * Mezonkenti eredmeny. A leftValue/rightValue AZT az erteket orzi, amit a
   * motor ténylegesen osszehasonlitott - igy a review felulet nem mutathat mas
   * erteket, mint amin a dontes alapult (spec 41/3).
   */
  fieldResults: Record<string, {
    state: FieldState;
    score: number | null;
    role: IdentityFieldRole;
    leftValue: unknown;
    rightValue: unknown;
  }>;
  agreementScore: number | null;
  evidenceCoverage: number | null;
  extractionQuality: number | null;
  retrievalSupport: number | null;
  topMargin: number | null;
  decisionStrength: number | null;
  contradictionCount: number;
  negativeHistory: number;
  reasonCodes: string[];
  explanationHu: string;
  candidateSources: CandidateChannel[];
  runnerUp: Array<{
    listingId: string; shopKey: string; rawName: string; url: string;
    decisionStrength: number; rejected: boolean; reasonCodes: string[];
  }>;
  decidedBy: 'engine' | 'human' | 'import' | 'system';
}

export interface MatchPolicy {
  matcherVersion: string;
  taxonomyVersion: string;
  policyVersion: string;
  autoMatchEnabled: boolean;
  autoMatchIdentifierOnly: boolean;
  thresholds: {
    autoMatch: {
      evidenceCoverage: number;
      extractionQuality: number;
      agreementScore: number;
      topMargin: number;
    };
    review: { minScore: number };
    ambiguousMargin: number;
    volumeToleranceMl: number;
  };
  fieldWeights: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Indoklás-kódok — a UI ezeket fordítja magyarra
// ═══════════════════════════════════════════════════════════════════════════

export const REASON_CODES = {
  // Hard contradiction
  PRODUCER_MISMATCH: 'PRODUCER_MISMATCH',
  BRAND_MISMATCH: 'BRAND_MISMATCH',
  CATEGORY_INCOMPATIBLE: 'CATEGORY_INCOMPATIBLE',
  EXPRESSION_MISMATCH: 'EXPRESSION_MISMATCH',
  VINTAGE_MISMATCH: 'VINTAGE_MISMATCH',
  VINTAGE_NV_CONFLICT: 'VINTAGE_NV_CONFLICT',
  AGE_STATEMENT_MISMATCH: 'AGE_STATEMENT_MISMATCH',
  EDITION_MISMATCH: 'EDITION_MISMATCH',
  VOLUME_MISMATCH: 'VOLUME_MISMATCH',
  PACK_COUNT_MISMATCH: 'PACK_COUNT_MISMATCH',
  PACKAGING_MISMATCH: 'PACKAGING_MISMATCH',
  PUTTONY_MISMATCH: 'PUTTONY_MISMATCH',
  ABV_MISMATCH: 'ABV_MISMATCH',
  GTIN_MISMATCH: 'GTIN_MISMATCH',
  DOSAGE_MISMATCH: 'DOSAGE_MISMATCH',
  CASK_MISMATCH: 'CASK_MISMATCH',
  FRUIT_MISMATCH: 'FRUIT_MISMATCH',
  NEGATIVE_ALIAS: 'NEGATIVE_ALIAS',
  MANUAL_REJECTION: 'MANUAL_REJECTION',
  WRONG_PLATFORM_VARIANT: 'WRONG_PLATFORM_VARIANT',
  // Hiányzó bizonyíték
  REQUIRED_VINTAGE_UNKNOWN: 'REQUIRED_VINTAGE_UNKNOWN',
  REQUIRED_VOLUME_UNKNOWN: 'REQUIRED_VOLUME_UNKNOWN',
  REQUIRED_PRODUCER_UNKNOWN: 'REQUIRED_PRODUCER_UNKNOWN',
  REQUIRED_EXPRESSION_UNKNOWN: 'REQUIRED_EXPRESSION_UNKNOWN',
  REQUIRED_FIELD_UNKNOWN: 'REQUIRED_FIELD_UNKNOWN',
  LOW_EVIDENCE_COVERAGE: 'LOW_EVIDENCE_COVERAGE',
  LOW_EXTRACTION_QUALITY: 'LOW_EXTRACTION_QUALITY',
  // Döntési
  SMALL_TOP_MARGIN: 'SMALL_TOP_MARGIN',
  MULTIPLE_SIMILAR_VARIANTS: 'MULTIPLE_SIMILAR_VARIANTS',
  FUZZY_ONLY_BRAND_MATCH: 'FUZZY_ONLY_BRAND_MATCH',
  SHOP_SPECIFIC_ALIAS_ONLY: 'SHOP_SPECIFIC_ALIAS_ONLY',
  AI_SUGGESTION_ONLY: 'AI_SUGGESTION_ONLY',
  EAN_MATCH_VINTAGE_UNPROVEN: 'EAN_MATCH_VINTAGE_UNPROVEN',
  INCONSISTENT_SOURCE_FIELDS: 'INCONSISTENT_SOURCE_FIELDS',
  AUTO_MATCH_DISABLED: 'AUTO_MATCH_DISABLED',
  AUTO_MATCH_IDENTIFIER_ONLY: 'AUTO_MATCH_IDENTIFIER_ONLY',
  CATEGORY_AUTOMATCH_BLOCKED: 'CATEGORY_AUTOMATCH_BLOCKED',
  NEGATIVE_HISTORY: 'NEGATIVE_HISTORY',
  // Keresési
  NO_CANDIDATE: 'NO_CANDIDATE',
  SOURCE_UNHEALTHY: 'SOURCE_UNHEALTHY',
  SEARCH_INCOMPLETE: 'SEARCH_INCOMPLETE',
  CATALOG_REGRESSION: 'CATALOG_REGRESSION',
  // Drift
  IDENTITY_DRIFT: 'IDENTITY_DRIFT',
  LISTING_BECAME_OTHER_PRODUCT: 'LISTING_BECAME_OTHER_PRODUCT',
  LISTING_MISSING: 'LISTING_MISSING',
  // Ár
  PRICE_ANOMALY: 'PRICE_ANOMALY',
  PRICE_NOT_COMPARABLE: 'PRICE_NOT_COMPARABLE',
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export const REASON_CODE_HU: Record<string, string> = {
  PRODUCER_MISMATCH: 'Eltérő termelő / borászat',
  BRAND_MISMATCH: 'Eltérő márka',
  CATEGORY_INCOMPATIBLE: 'Összeegyeztethetetlen kategória',
  EXPRESSION_MISMATCH: 'Eltérő tétel / expression',
  VINTAGE_MISMATCH: 'Eltérő évjárat',
  VINTAGE_NV_CONFLICT: 'Évjáratos és évjárat nélküli ellentmondás',
  AGE_STATEMENT_MISMATCH: 'Eltérő korjelölés',
  EDITION_MISMATCH: 'Eltérő kiadás',
  VOLUME_MISMATCH: 'Eltérő kiszerelés',
  PACK_COUNT_MISMATCH: 'Eltérő darabszám / csomag',
  PACKAGING_MISMATCH: 'Eltérő csomagolás (pl. díszdoboz)',
  PUTTONY_MISMATCH: 'Eltérő puttonyszám',
  ABV_MISMATCH: 'Eltérő alkoholtartalom',
  GTIN_MISMATCH: 'Eltérő EAN / GTIN',
  DOSAGE_MISMATCH: 'Eltérő dosage (brut / demi-sec)',
  CASK_MISMATCH: 'Eltérő hordóérlelés',
  FRUIT_MISMATCH: 'Eltérő gyümölcs',
  NEGATIVE_ALIAS: 'Kizárt névpár (negatív alias)',
  MANUAL_REJECTION: 'Korábbi kézi elutasítás',
  WRONG_PLATFORM_VARIANT: 'Rossz platformvariáns',
  REQUIRED_VINTAGE_UNKNOWN: 'Kötelező évjárat nem bizonyított',
  REQUIRED_VOLUME_UNKNOWN: 'Kötelező kiszerelés nem bizonyított',
  REQUIRED_PRODUCER_UNKNOWN: 'Kötelező termelő nem bizonyított',
  REQUIRED_EXPRESSION_UNKNOWN: 'Kötelező tétel nem bizonyított',
  REQUIRED_FIELD_UNKNOWN: 'Kötelező mező nem bizonyított',
  LOW_EVIDENCE_COVERAGE: 'Alacsony bizonyíték-lefedettség',
  LOW_EXTRACTION_QUALITY: 'Alacsony kinyerési minőség',
  SMALL_TOP_MARGIN: 'Az első két jelölt túl közel van egymáshoz',
  MULTIPLE_SIMILAR_VARIANTS: 'Több nagyon hasonló variáns',
  FUZZY_ONLY_BRAND_MATCH: 'A márkaegyezés csak fuzzy',
  SHOP_SPECIFIC_ALIAS_ONLY: 'Csak webshop-specifikus névkapcsolat',
  AI_SUGGESTION_ONLY: 'Csak AI-javaslat támasztja alá',
  EAN_MATCH_VINTAGE_UNPROVEN: 'EAN egyezik, de az évjárat nem bizonyított',
  INCONSISTENT_SOURCE_FIELDS: 'A forrás mezői egymásnak ellentmondanak',
  AUTO_MATCH_DISABLED: 'Az automatikus párosítás ki van kapcsolva',
  AUTO_MATCH_IDENTIFIER_ONLY: 'Automatikus párosítás csak erős azonosítóval',
  CATEGORY_AUTOMATCH_BLOCKED: 'A kategória nem enged automatikus párosítást',
  NEGATIVE_HISTORY: 'Korábban elutasított jelölt',
  NO_CANDIDATE: 'Nincs jelölt',
  SOURCE_UNHEALTHY: 'A forrás technikai állapota nem megfelelő',
  SEARCH_INCOMPLETE: 'A keresés nem futott le teljesen',
  CATALOG_REGRESSION: 'A katalógus mérete gyanúsan visszaesett',
  IDENTITY_DRIFT: 'A listing identitása megváltozott',
  LISTING_BECAME_OTHER_PRODUCT: 'Az URL másik termékre mutat',
  LISTING_MISSING: 'A listing eltűnt',
  PRICE_ANOMALY: 'Áranomália',
  PRICE_NOT_COMPARABLE: 'Az ár nem összehasonlítható',
};

// ═══════════════════════════════════════════════════════════════════════════
// API DTO-k
// ═══════════════════════════════════════════════════════════════════════════

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: Record<string, unknown> };
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export function hasRole(user: { role: UserRole } | null | undefined, ...allowed: UserRole[]): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return allowed.includes(user.role);
}

export function atLeast(user: { role: UserRole } | null | undefined, min: UserRole): boolean {
  if (!user) return false;
  return ROLE_RANK[user.role] >= ROLE_RANK[min];
}
