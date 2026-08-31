/**
 * Haromallapotu mezo-osszehasonlitas (spec 15.2) es hard contradiction
 * szabalyok (spec 15.3).
 *
 * ALAPELVEK:
 *  - `match`: mindket oldalon ismert ES egyezik;
 *  - `contradiction`: mindket oldalon ismert ES elter;
 *  - `unknown`: legalabb az egyik oldalon nincs kelloen bizonyitott ertek.
 *  - Az `unknown` SOHA nem alakithato `match`-re (spec 38/7).
 *  - A pontszam SOHA nem irhatja felul a hard contradictiont (spec 38/6).
 */
import type {
  FieldComparison, FieldState, HardContradiction, IdentityFields,
  IdentityFieldRole, ComparisonPolicy,
} from '@radovin/contracts';
import { REASON_CODES } from '@radovin/contracts';
import { nameSimilarity, searchNorm, levenshteinRatio } from '../normalization/text.js';
import { volumeEquivalent, packagingEquivalent, abvEquivalent } from '../normalization/units.js';
import { vintageContradiction } from '../normalization/vintage.js';
import type { ResolvedIdentityProfile } from '../identity/profile.js';

export interface ComparatorContext {
  profile: ResolvedIdentityProfile;
  policy: ComparisonPolicy;
  /** Jovahagyott alias-feloldasok: normalizalt szoveg -> kanonikus cel id/ertek. */
  aliasResolver?: (type: 'brand' | 'producer' | 'expression', text: string, shopId?: string) =>
    { targetId?: string; targetLiteral?: string; shopSpecific: boolean } | null;
  /** Negativ alias par: bizonyitottan NEM azonos termekvonalak. */
  negativeAliasCheck?: (a: string, b: string, categoryKey: string | null) => string | null;
  /** Ha a marka fuzzy egyezese tiltott (szemelynev-alapu pinceszet). */
  fuzzyBlocked?: (side: 'left' | 'right') => boolean;
  shopId?: string;
}

const GTIN_STRIP = /[^0-9]/g;

export function normalizeGtin(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(GTIN_STRIP, '');
  if (digits.length < 8) return null;
  // EAN-13-ra normalizalunk: UPC-A (12) -> 0 + 12
  if (digits.length === 12) return `0${digits}`;
  if (digits.length === 13 || digits.length === 14 || digits.length === 8) return digits;
  return digits.length > 14 ? digits.slice(-14) : digits;
}

export function gtinEqual(a: string | null, b: string | null): boolean {
  const na = normalizeGtin(a);
  const nb = normalizeGtin(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // GTIN-14 vs EAN-13 osszevetes a vezeto nullak nelkul
  return na.replace(/^0+/, '') === nb.replace(/^0+/, '');
}

interface FieldSpec {
  field: keyof IdentityFields | string;
  weightKey: string;
  /** Ha true, az eltres HARD contradiction (a policy szerinti kivetelekkel). */
  hardOnMismatch: boolean;
  reasonCode: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { field: 'producer', weightKey: 'producer', hardOnMismatch: true, reasonCode: REASON_CODES.PRODUCER_MISMATCH },
  { field: 'brand', weightKey: 'producer', hardOnMismatch: true, reasonCode: REASON_CODES.BRAND_MISMATCH },
  { field: 'categoryKey', weightKey: 'category', hardOnMismatch: true, reasonCode: REASON_CODES.CATEGORY_INCOMPATIBLE },
  { field: 'expression', weightKey: 'expression', hardOnMismatch: true, reasonCode: REASON_CODES.EXPRESSION_MISMATCH },
  { field: 'vintageValue', weightKey: 'vintage', hardOnMismatch: true, reasonCode: REASON_CODES.VINTAGE_MISMATCH },
  { field: 'ageStatementYears', weightKey: 'vintage', hardOnMismatch: true, reasonCode: REASON_CODES.AGE_STATEMENT_MISMATCH },
  { field: 'volumeMl', weightKey: 'volume', hardOnMismatch: true, reasonCode: REASON_CODES.VOLUME_MISMATCH },
  { field: 'packCount', weightKey: 'volume', hardOnMismatch: true, reasonCode: REASON_CODES.PACK_COUNT_MISMATCH },
  { field: 'packagingType', weightKey: 'volume', hardOnMismatch: true, reasonCode: REASON_CODES.PACKAGING_MISMATCH },
  { field: 'edition', weightKey: 'vintage', hardOnMismatch: true, reasonCode: REASON_CODES.EDITION_MISMATCH },
  { field: 'caskFinish', weightKey: 'expression', hardOnMismatch: true, reasonCode: REASON_CODES.CASK_MISMATCH },
  { field: 'dosageStyle', weightKey: 'expression', hardOnMismatch: true, reasonCode: REASON_CODES.DOSAGE_MISMATCH },
  { field: 'puttony', weightKey: 'expression', hardOnMismatch: true, reasonCode: REASON_CODES.PUTTONY_MISMATCH },
  { field: 'fruit', weightKey: 'expression', hardOnMismatch: true, reasonCode: REASON_CODES.FRUIT_MISMATCH },
  { field: 'abvPercent', weightKey: 'abv', hardOnMismatch: true, reasonCode: REASON_CODES.ABV_MISMATCH },
  { field: 'gtin', weightKey: 'gtin', hardOnMismatch: true, reasonCode: REASON_CODES.GTIN_MISMATCH },
  // A bortipus a MODELLEZETT azonossaghordozo; a colour ennek szoveges arnyeka,
  // ezert az marad puha jel. (Ha a colour is hard gate lenne, egy rose
  // Kekfrankos, ahol az egyik bolt kiirja a tipust, a masik nem, hamis
  // ellentmondast kapna a fajta alapertelmezett szinebol.)
  { field: 'wineStyleId', weightKey: 'expression', hardOnMismatch: true, reasonCode: 'WINE_STYLE_MISMATCH' },
  { field: 'vineyardId', weightKey: 'expression', hardOnMismatch: true, reasonCode: 'VINEYARD_MISMATCH' },
  { field: 'colour', weightKey: 'region', hardOnMismatch: false, reasonCode: 'COLOUR_MISMATCH' },
  { field: 'region', weightKey: 'region', hardOnMismatch: false, reasonCode: 'REGION_MISMATCH' },
  { field: 'countryCode', weightKey: 'region', hardOnMismatch: false, reasonCode: 'COUNTRY_MISMATCH' },
  { field: 'sweetness', weightKey: 'region', hardOnMismatch: false, reasonCode: 'SWEETNESS_MISMATCH' },
  // A fajtaelteres KIZAR. A komparator csak TELJESEN diszjunkt halmazoknal ad
  // ellentmondast (Jaccard = 0); reszleges atfedesnel tartozkodik. Ez akkor
  // biztonsagos, ha a fajtak KANONIKUS nevre vannak feloldva - kulonben az
  // "Olaszrizling" es a "Welschriesling" hamis kizarast adna.
  { field: 'grapeVarieties', weightKey: 'region', hardOnMismatch: true, reasonCode: 'GRAPE_MISMATCH' },
  { field: 'flavour', weightKey: 'expression', hardOnMismatch: true, reasonCode: 'FLAVOUR_MISMATCH' },
  { field: 'aging', weightKey: 'vintage', hardOnMismatch: true, reasonCode: 'AGING_MISMATCH' },
];

export interface CompareResult {
  fields: FieldComparison[];
  hardContradictions: HardContradiction[];
  /** A `required` mezok kozul melyek maradtak unknown allapotban. */
  unknownRequired: string[];
  /** Igaz, ha a marka/expression egyezes CSAK fuzzy hasonlosagon alapul. */
  fuzzyOnlyBrandMatch: boolean;
  /** Igaz, ha a nevkapcsolatot csak webshop-specifikus alias indokolja. */
  shopSpecificAliasOnly: boolean;
}

/**
 * A ket identitas osszevetese. A profile dönti el, mely mezo `required`.
 */
export function compareIdentityFields(
  left: IdentityFields,
  right: IdentityFields,
  ctx: ComparatorContext,
  weights: Record<string, number>,
): CompareResult {
  const fields: FieldComparison[] = [];
  const hard: HardContradiction[] = [];
  const unknownRequired: string[] = [];
  let fuzzyOnlyBrandMatch = false;
  let shopSpecificAliasOnly = false;

  // ── Kulon kezelt: evjarat / vintage status ────────────────────────────────
  const vintageRole = ctx.profile.roleOf('vintageValue');
  if (vintageRole !== 'not_applicable') {
    const vc = vintageContradiction(
      { value: left.vintageValue, status: left.vintageStatus },
      { value: right.vintageValue, status: right.vintageStatus },
    );
    const bothKnown =
      (left.vintageStatus === 'vintage' || left.vintageStatus === 'non_vintage') &&
      (right.vintageStatus === 'vintage' || right.vintageStatus === 'non_vintage');
    let state: FieldState = 'unknown';
    if (vc.contradiction) state = 'contradiction';
    else if (bothKnown) state = 'match';

    const isHard = vc.contradiction && ctx.profile.isVintageSensitive();
    fields.push({
      field: 'vintage', role: vintageRole, state, isHard,
      leftValue: left.vintageValue ?? left.vintageStatus,
      rightValue: right.vintageValue ?? right.vintageStatus,
      score: state === 'match' ? 1 : state === 'contradiction' ? 0 : null,
      weight: weights['vintage'] ?? 0.16,
      reason: vc.code,
    });
    if (isHard) {
      hard.push({
        field: 'vintage', code: vc.code ?? REASON_CODES.VINTAGE_MISMATCH,
        leftValue: left.vintageValue ?? left.vintageStatus,
        rightValue: right.vintageValue ?? right.vintageStatus,
        message: 'Az evjarat / vintage status bizonyitottan elter.',
      });
    }
    if (vintageRole === 'required' && state === 'unknown') unknownRequired.push('vintage');
  }

  // ── Altalanos mezok ──────────────────────────────────────────────────────
  for (const spec of FIELD_SPECS) {
    const fieldName = String(spec.field);
    if (fieldName === 'vintageValue') continue; // fent kezelve
    const role = ctx.profile.roleOf(fieldName);
    if (role === 'not_applicable') continue;

    const lv = (left as unknown as Record<string, unknown>)[fieldName];
    const rv = (right as unknown as Record<string, unknown>)[fieldName];
    const cmp = compareSingleField(fieldName, lv, rv, left, right, ctx);

    const weight = weights[spec.weightKey] ?? 0.05;
    const isHard =
      cmp.state === 'contradiction' &&
      spec.hardOnMismatch &&
      (role === 'required' || role === 'contradiction_only');

    fields.push({
      field: fieldName, role, state: cmp.state, isHard,
      leftValue: lv ?? null, rightValue: rv ?? null,
      score: cmp.score, weight, reason: cmp.reason,
    });

    if (isHard) {
      hard.push({
        field: fieldName,
        code: spec.reasonCode,
        leftValue: lv ?? null,
        rightValue: rv ?? null,
        message: cmp.reason ?? `A(z) ${fieldName} mezo bizonyitottan elter.`,
      });
    }
    if (role === 'required' && cmp.state === 'unknown') unknownRequired.push(fieldName);
    if (cmp.fuzzyOnly && (fieldName === 'brand' || fieldName === 'producer')) fuzzyOnlyBrandMatch = true;
    if (cmp.shopSpecificAlias) shopSpecificAliasOnly = true;
  }

  // ── Negativ alias: explicit kizart nevpar (spec 8.10) ────────────────────
  if (ctx.negativeAliasCheck) {
    const pairs: Array<[string | null, string | null]> = [
      [left.expression, right.expression],
      [left.brand, right.brand],
      [left.edition, right.edition],
    ];
    for (const [a, b] of pairs) {
      if (!a || !b) continue;
      const reason = ctx.negativeAliasCheck(a, b, left.categoryKey ?? right.categoryKey);
      if (reason) {
        hard.push({
          field: 'negative_alias', code: REASON_CODES.NEGATIVE_ALIAS,
          leftValue: a, rightValue: b, message: reason,
        });
        break;
      }
    }
  }

  return { fields, hardContradictions: hard, unknownRequired, fuzzyOnlyBrandMatch, shopSpecificAliasOnly };
}

interface SingleFieldResult {
  state: FieldState;
  score: number | null;
  reason?: string;
  fuzzyOnly?: boolean;
  shopSpecificAlias?: boolean;
}

function compareSingleField(
  field: string,
  lv: unknown,
  rv: unknown,
  left: IdentityFields,
  right: IdentityFields,
  ctx: ComparatorContext,
): SingleFieldResult {
  const known = (v: unknown) =>
    v !== null && v !== undefined && v !== '' &&
    !(typeof v === 'string' && v.toLowerCase() === 'unknown') &&
    !(Array.isArray(v) && v.length === 0);

  switch (field) {
    case 'volumeMl': {
      if (!known(lv) || !known(rv)) return { state: 'unknown', score: null };
      const eq = volumeEquivalent(Number(lv), Number(rv), ctx.policy.volumeToleranceMl);
      return eq
        ? { state: 'match', score: 1 }
        : { state: 'contradiction', score: 0, reason: `Kiszereles: ${String(lv)} ml vs ${String(rv)} ml` };
    }
    case 'packCount': {
      const a = Number(lv ?? 1);
      const b = Number(rv ?? 1);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return { state: 'unknown', score: null };
      if (a === b) return { state: 'match', score: 1 };
      if (!ctx.policy.packMustMatch) return { state: 'unknown', score: null };
      return { state: 'contradiction', score: 0, reason: `Darabszam: ${a} vs ${b}` };
    }
    case 'packagingType': {
      const a = String(lv ?? 'unknown');
      const b = String(rv ?? 'unknown');
      if (a === 'unknown' && b === 'unknown') return { state: 'unknown', score: null };
      // Az 'unknown' vs 'standard' nem ellentmondas, csak bizonytalansag.
      if (a === 'unknown' || b === 'unknown') {
        const other = a === 'unknown' ? b : a;
        if (other === 'standard') return { state: 'unknown', score: null };
        return { state: 'unknown', score: null, reason: `Csomagolas nem bizonyitott a masik oldalon (${other}).` };
      }
      const eq = packagingEquivalent(a as never, b as never, ctx.policy);
      return eq
        ? { state: 'match', score: 1 }
        : { state: 'contradiction', score: 0, reason: `Csomagolas: ${a} vs ${b}` };
    }
    case 'abvPercent': {
      if (!known(lv) || !known(rv)) return { state: 'unknown', score: null };
      const eq = abvEquivalent(Number(lv), Number(rv));
      return eq
        ? { state: 'match', score: 1 }
        : { state: 'contradiction', score: 0, reason: `Alkoholtartalom: ${String(lv)}% vs ${String(rv)}%` };
    }
    case 'gtin': {
      const a = normalizeGtin(lv as string);
      const b = normalizeGtin(rv as string);
      if (!a || !b) return { state: 'unknown', score: null };
      return gtinEqual(a, b)
        ? { state: 'match', score: 1 }
        : { state: 'contradiction', score: 0, reason: `EAN/GTIN: ${a} vs ${b}` };
    }
    case 'ageStatementYears':
    case 'puttony': {
      if (!known(lv) || !known(rv)) return { state: 'unknown', score: null };
      return Number(lv) === Number(rv)
        ? { state: 'match', score: 1 }
        : { state: 'contradiction', score: 0, reason: `${field}: ${String(lv)} vs ${String(rv)}` };
    }
    case 'wineStyleId':
    case 'vineyardId': {
      // Azonositok: nincs fuzzy, nincs reszleges egyezes.
      if (!known(lv) || !known(rv)) return { state: 'unknown', score: null };
      return String(lv) === String(rv)
        ? { state: 'match', score: 1 }
        : { state: 'contradiction', score: 0, reason: `${field}: ${String(lv)} vs ${String(rv)}` };
    }
    case 'grapeVarieties': {
      const a = (Array.isArray(lv) ? lv : []).map((x) => searchNorm(String(x))).filter(Boolean).sort();
      const b = (Array.isArray(rv) ? rv : []).map((x) => searchNorm(String(x))).filter(Boolean).sort();
      if (!a.length || !b.length) return { state: 'unknown', score: null };
      const inter = a.filter((x) => b.includes(x)).length;
      const jac = inter / new Set([...a, ...b]).size;
      if (jac >= 0.8) return { state: 'match', score: jac };
      if (jac === 0) return { state: 'contradiction', score: 0, reason: `Szolofajta: ${a.join('/')} vs ${b.join('/')}` };
      return { state: 'unknown', score: jac };
    }
    case 'brand':
    case 'producer': {
      if (!known(lv) || !known(rv)) return { state: 'unknown', score: null };
      const a = searchNorm(String(lv));
      const b = searchNorm(String(rv));
      if (a === b) return { state: 'match', score: 1 };

      // Jovahagyott alias-feloldas
      if (ctx.aliasResolver) {
        const kind = field === 'brand' ? 'brand' : 'producer';
        const ra = ctx.aliasResolver(kind, a, ctx.shopId);
        const rb = ctx.aliasResolver(kind, b, ctx.shopId);
        const idA = ra?.targetId ?? ra?.targetLiteral ?? null;
        const idB = rb?.targetId ?? rb?.targetLiteral ?? null;
        if (idA && idB && idA === idB) {
          return { state: 'match', score: 0.98, shopSpecificAlias: Boolean(ra?.shopSpecific || rb?.shopSpecific) };
        }
        if (idA && searchNorm(String(idA)) === b) return { state: 'match', score: 0.97, shopSpecificAlias: ra?.shopSpecific };
        if (idB && searchNorm(String(idB)) === a) return { state: 'match', score: 0.97, shopSpecificAlias: rb?.shopSpecific };
      }

      // Fuzzy: NEM hozhat letre uj markaazonossagot automatikusan (spec 13.3)
      if (ctx.fuzzyBlocked?.('left') || ctx.fuzzyBlocked?.('right')) {
        return { state: 'contradiction', score: 0, reason: `Marka/termelo elter, fuzzy egyezes tiltott: ${a} vs ${b}` };
      }
      const sim = nameSimilarity(a, b);
      const lev = levenshteinRatio(a, b);
      // Rovid markaneveknel a fuzzy kulonosen veszelyes
      const shortest = Math.min(a.length, b.length);
      if (shortest <= 6 && lev < 0.92) {
        return { state: 'contradiction', score: 0, reason: `Rovid, elteroe marka: ${a} vs ${b}` };
      }
      if (sim >= 0.82 || lev >= 0.9) {
        return { state: 'match', score: Math.max(sim, lev), fuzzyOnly: true };
      }
      return { state: 'contradiction', score: sim, reason: `Marka/termelo: ${a} vs ${b}` };
    }
    case 'expression': {
      if (!known(lv) || !known(rv)) return { state: 'unknown', score: null };
      const a = searchNorm(String(lv));
      const b = searchNorm(String(rv));
      if (a === b) return { state: 'match', score: 1 };
      if (ctx.aliasResolver) {
        const ra = ctx.aliasResolver('expression', a, ctx.shopId);
        const rb = ctx.aliasResolver('expression', b, ctx.shopId);
        const idA = ra?.targetId ?? ra?.targetLiteral ?? null;
        const idB = rb?.targetId ?? rb?.targetLiteral ?? null;
        if (idA && idB && idA === idB) {
          return { state: 'match', score: 0.97, shopSpecificAlias: Boolean(ra?.shopSpecific || rb?.shopSpecific) };
        }
      }
      const sim = nameSimilarity(a, b);
      if (sim >= 0.90) return { state: 'match', score: sim, fuzzyOnly: true };
      if (sim >= 0.62) return { state: 'unknown', score: sim, reason: 'A tetelnev csak reszben egyezik.' };
      return { state: 'contradiction', score: sim, reason: `Tetel/expression: ${a} vs ${b}` };
    }
    case 'categoryKey': {
      if (!known(lv) || !known(rv)) return { state: 'unknown', score: null };
      const a = String(lv);
      const b = String(rv);
      if (a === b) return { state: 'match', score: 1 };
      if (a === 'uncategorized' || b === 'uncategorized') return { state: 'unknown', score: null };
      // Rokon kategoriak: pezsgo/champagne, tokaji/bor
      const related: Record<string, string[]> = {
        sparkling_wine: ['champagne'],
        champagne: ['sparkling_wine'],
        wine: ['tokaji_aszu'],
        tokaji_aszu: ['wine'],
        other_spirit: ['whisky', 'rum', 'gin', 'vodka', 'cognac', 'tequila', 'liqueur', 'palinka'],
      };
      if (related[a]?.includes(b) || related[b]?.includes(a)) {
        return { state: 'unknown', score: 0.6, reason: 'Rokon kategoria, de nem azonos besorolas.' };
      }
      return { state: 'contradiction', score: 0, reason: `Kategoria: ${a} vs ${b}` };
    }
    default: {
      if (!known(lv) || !known(rv)) return { state: 'unknown', score: null };
      const a = searchNorm(String(lv));
      const b = searchNorm(String(rv));
      if (a === b) return { state: 'match', score: 1 };
      const sim = nameSimilarity(a, b);
      if (sim >= 0.9) return { state: 'match', score: sim, fuzzyOnly: true };
      if (sim >= 0.55) return { state: 'unknown', score: sim };
      return { state: 'contradiction', score: sim, reason: `${field}: ${a} vs ${b}` };
    }
  }
}

/** Segedfuggveny a role -> emberi cimke leforditasahoz a UI szamara. */
export const ROLE_LABEL_HU: Record<IdentityFieldRole, string> = {
  required: 'Kotelezo',
  contradiction_only: 'Kizaro',
  supporting: 'Tamogato',
  not_applicable: 'Nem ertelmezett',
};
