/**
 * Determinisztikus identitas-kinyeres szovegbol, bizonyitekkal (spec 9.4, 12.1).
 *
 * Ez a reteg NEM talal ki semmit. Ha nincs bizonyitek, az ertek `unknown`.
 * Az AI-kiegeszites kulon, szigoru sema mellett fut (spec 12.4), es szinten
 * kotelezoen bizonyitekot ad.
 */
import type { Evidence, EvidenceMap, ExtractionMethod, IdentityFields } from '@radovin/contracts';
import { emptyIdentityFields } from '@radovin/contracts';
import { cleanText, searchNorm } from '../normalization/text.js';
import { parseVolume, parsePackaging, parseAbv } from '../normalization/units.js';
import { parseVintage, parseAgeStatement, parsePuttony } from '../normalization/vintage.js';

export interface ExtractionSource {
  /** Termeknev - a legfontosabb szoveges forras. */
  name: string;
  /** Strukturalt platform/JSON-LD mezok, ha vannak. */
  structured?: Record<string, unknown>;
  /** Specifikacios tablazat kulcs-ertek parjai. */
  specs?: Record<string, string>;
  /** Breadcrumb / kategoriaut. */
  categoryPath?: string[];
  description?: string;
  url?: string;
  brandHint?: string | null;
  /** Ismert markak/termelok feloldasahoz. */
  resolveBrand?: (text: string) => { id: string; canonicalName: string; producerId?: string | null } | null;
  resolveProducer?: (text: string) => { id: string; canonicalName: string } | null;
  resolveCategory?: (text: string) => { key: string } | null;
}

export interface IdentityExtractionResult {
  identity: IdentityFields;
  evidence: EvidenceMap;
  warnings: string[];
}

function ev<T>(
  field: string,
  normalized: T,
  raw: string | null,
  location: string,
  excerpt: string | null,
  method: ExtractionMethod,
  confidence: number,
): Evidence<T> {
  return {
    field,
    normalized_value: normalized,
    raw_value: raw,
    source_location: location,
    source_excerpt: excerpt,
    method,
    confidence: Math.max(0, Math.min(1, confidence)),
    observed_at: new Date().toISOString(),
  };
}

const DOSAGE_TERMS: Array<[RegExp, string]> = [
  [/\bbrut\s*nature\b/i, 'brut nature'],
  [/\bextra\s*brut\b/i, 'extra brut'],
  [/\bbrut\b/i, 'brut'],
  [/\bextra\s*(?:dry|sec)\b/i, 'extra sec'],
  [/\bdemi[\s-]*sec\b/i, 'demi-sec'],
  [/\bdoux\b/i, 'doux'],
  [/\bsec\b/i, 'sec'],
];

const SWEETNESS_TERMS: Array<[RegExp, string]> = [
  [/\bszaraz\b/i, 'szaraz'],
  [/\bfelszaraz\b/i, 'felszaraz'],
  [/\bfeledes\b/i, 'feledes'],
  [/\bedes\b/i, 'edes'],
  [/\bdry\b/i, 'szaraz'],
  [/\bsweet\b/i, 'edes'],
  [/\bmedium\s*dry\b/i, 'felszaraz'],
];

const COLOUR_TERMS: Array<[RegExp, string]> = [
  [/\bvorosbor\b|\bvoros\b|\bred\b|\brouge\b/i, 'red'],
  [/\bfeherbor\b|\bfeher\b|\bwhite\b|\bblanc\b/i, 'white'],
  [/\broze\b|\brose\b|\bra?ose\b/i, 'rose'],
  [/\bnarancsbor\b|\borange\s*wine\b/i, 'orange'],
];

const CASK_TERMS: Array<[RegExp, string]> = [
  [/\bsherry\s*cask\b|\bsherry\s*finish\b|\bsherry\s*hordo\b/i, 'sherry cask'],
  [/\bport\s*cask\b|\bport\s*finish\b/i, 'port cask'],
  [/\brum\s*cask\b|\brum\s*finish\b/i, 'rum cask'],
  [/\bbourbon\s*cask\b/i, 'bourbon cask'],
  [/\bmadeira\s*cask\b/i, 'madeira cask'],
  [/\bpx\s*cask\b|\bpedro\s*ximenez\b/i, 'px cask'],
  [/\bbarrique\b/i, 'barrique'],
];

const EDITION_TERMS: Array<[RegExp, string]> = [
  [/\bdouble\s*black\b/i, 'double black'],
  [/\bblack\s*label\b/i, 'black label'],
  [/\bblue\s*label\b/i, 'blue label'],
  [/\bgreen\s*label\b/i, 'green label'],
  [/\bgold\s*(?:label|reserve)\b/i, 'gold reserve'],
  [/\bred\s*label\b/i, 'red label'],
  [/\bdistillers?\s*edition\b/i, 'distillers edition'],
  [/\bspecial\s*reserve\b/i, 'special reserve'],
  [/\bsingle\s*cask\b/i, 'single cask'],
  [/\bsmall\s*batch\b/i, 'small batch'],
  [/\bcask\s*strength\b/i, 'cask strength'],
  [/\bnavy\s*strength\b/i, 'navy strength'],
  [/\blimited\s*edition\b|\blimitalt\s*kiadas\b/i, 'limited edition'],
  [/\bxo\b/i, 'xo'],
  [/\bvsop\b/i, 'vsop'],
  [/\bvs\b(?!\s*op)/i, 'vs'],
  [/\bnapoleon\b/i, 'napoleon'],
  [/\bagyas\b/i, 'agyas'],
  [/\berlelt\b/i, 'erlelt'],
  [/\bjegbor\b|\bice\s*wine\b|\beiswein\b/i, 'jegbor'],
  [/\bkesoi\s*szuretelesu\b|\blate\s*harvest\b/i, 'kesoi szuretelesu'],
];

const FRUIT_TERMS: Array<[RegExp, string]> = [
  [/\bszilva\b|\bplum\b/i, 'szilva'],
  [/\bbarack\b|\bkajszi\b|\bapricot\b/i, 'barack'],
  [/\bcseresznye\b|\bcherry\b/i, 'cseresznye'],
  [/\bmeggy\b|\bsour\s*cherry\b/i, 'meggy'],
  [/\bkorte\b|\bpear\b|\bvilmos\b/i, 'korte'],
  [/\balma\b|\bapple\b/i, 'alma'],
  [/\bmalna\b|\braspberry\b/i, 'malna'],
  [/\bbirs\b|\bquince\b/i, 'birs'],
  [/\bszolo\b|\btorkoly\b/i, 'torkoly'],
  [/\bfeketeribizli\b|\bribizli\b/i, 'ribizli'],
  [/\bberkenye\b/i, 'berkenye'],
  [/\bhomoktovis\b/i, 'homoktovis'],
];

const CONTAINER_TERMS: Array<[RegExp, string]> = [
  [/\bbag\s*in\s*box\b|\bbib\b/i, 'bag_in_box'],
  [/\bdoboz(?:os)?\s*(?:sor|ital)?\b|\bcan\b/i, 'can'],
  [/\bhordo\b|\bkeg\b/i, 'keg'],
];

function firstMatch(text: string, patterns: Array<[RegExp, string]>): { value: string; raw: string } | null {
  for (const [re, value] of patterns) {
    const m = text.match(re);
    if (m) return { value, raw: m[0] ?? '' };
  }
  return null;
}

/**
 * Fo belepesi pont: identitasmezok kinyerese a rendelkezesre allo forrasokbol.
 * Prioritas: strukturalt > spec tabla > nev > leiras > URL (spec 12.1).
 */
export function extractIdentity(source: ExtractionSource): IdentityExtractionResult {
  const identity = emptyIdentityFields();
  const evidence: EvidenceMap = {};
  const warnings: string[] = [];

  const name = cleanText(source.name);
  const nameNorm = searchNorm(name);
  const specText = source.specs ? Object.entries(source.specs).map(([k, v]) => `${k}: ${v}`).join(' | ') : '';
  const specNorm = searchNorm(specText);
  const combined = `${name} ${specText}`;
  const combinedNorm = searchNorm(combined);
  const structured = source.structured ?? {};

  // ── Kategoria ────────────────────────────────────────────────────────────
  if (source.resolveCategory) {
    const paths = source.categoryPath ?? [];
    for (const p of [...paths].reverse()) {
      const hit = source.resolveCategory(p);
      if (hit) {
        identity.categoryKey = hit.key;
        evidence['categoryKey'] = ev('categoryKey', hit.key, p, 'breadcrumb', p, 'breadcrumb', 0.8);
        break;
      }
    }
    if (!identity.categoryKey) {
      const hit = source.resolveCategory(name);
      if (hit) {
        identity.categoryKey = hit.key;
        evidence['categoryKey'] = ev('categoryKey', hit.key, name, 'name', name, 'taxonomy', 0.6);
      }
    }
  }

  // ── Marka / termelo ──────────────────────────────────────────────────────
  const brandHint = source.brandHint ? cleanText(source.brandHint) : null;
  if (brandHint && source.resolveBrand) {
    const hit = source.resolveBrand(brandHint);
    if (hit) {
      identity.brand = hit.canonicalName;
      identity.brandId = hit.id;
      if (hit.producerId) identity.producerId = hit.producerId;
      evidence['brand'] = ev('brand', hit.canonicalName, brandHint, 'structured.brand', brandHint, 'jsonld', 0.95);
    } else {
      identity.brand = brandHint;
      evidence['brand'] = ev('brand', brandHint, brandHint, 'structured.brand', brandHint, 'jsonld', 0.7);
    }
  }
  if (!identity.brand && source.resolveBrand) {
    const hit = source.resolveBrand(name);
    if (hit) {
      identity.brand = hit.canonicalName;
      identity.brandId = hit.id;
      if (hit.producerId) identity.producerId = hit.producerId;
      evidence['brand'] = ev('brand', hit.canonicalName, name, 'name', name, 'taxonomy', 0.78);
    }
  }
  if (source.resolveProducer) {
    const hit = source.resolveProducer(brandHint ?? name);
    if (hit) {
      identity.producer = hit.canonicalName;
      identity.producerId = hit.id;
      evidence['producer'] = ev('producer', hit.canonicalName, brandHint ?? name, brandHint ? 'structured.brand' : 'name', brandHint ?? name, 'taxonomy', brandHint ? 0.9 : 0.75);
    }
  }

  // ── Kiszereles es darabszam ──────────────────────────────────────────────
  const structVolume = numberFrom(structured['volume_ml'] ?? structured['size'] ?? structured['weight']);
  if (structVolume && structVolume >= 20 && structVolume <= 30000) {
    identity.volumeMl = Math.round(structVolume);
    evidence['volumeMl'] = ev('volumeMl', identity.volumeMl, String(structured['volume_ml'] ?? structured['size']), 'structured.volume', String(structured['volume_ml'] ?? structured['size']), 'platform_api', 0.97);
  } else {
    const vol = parseVolume(combined);
    if (vol.unitVolumeMl) {
      identity.volumeMl = vol.unitVolumeMl;
      evidence['volumeMl'] = ev('volumeMl', vol.unitVolumeMl, vol.rawMatch, specNorm.includes(searchNorm(vol.rawMatch ?? '')) ? 'specs' : 'name', vol.rawMatch, specText ? 'spec_table' : 'title', vol.confidence);
    }
    if (vol.packCount > 1) {
      identity.packCount = vol.packCount;
      evidence['packCount'] = ev('packCount', vol.packCount, vol.rawMatch, 'name', vol.rawMatch, 'title', vol.confidence);
    }
  }

  // ── Csomagolas ───────────────────────────────────────────────────────────
  const pack = parsePackaging(combined);
  if (pack.packagingType !== 'unknown') {
    identity.packagingType = pack.packagingType;
    evidence['packagingType'] = ev('packagingType', pack.packagingType, pack.rawMatch, 'name', pack.rawMatch, 'title', pack.confidence);
  } else if (identity.volumeMl) {
    // Ha van bizonyitott kiszereles es semmilyen kulon csomagolasi jelzes,
    // a "standard" ertelmes alapertelmezes - de kisebb konfidenciaval.
    identity.packagingType = 'standard';
    evidence['packagingType'] = ev('packagingType', 'standard', null, 'derived', 'nincs csomagolasi jelzes a forrason', 'derived', 0.55);
  }

  const container = firstMatch(combinedNorm, CONTAINER_TERMS);
  if (container) {
    identity.containerType = container.value;
    evidence['containerType'] = ev('containerType', container.value, container.raw, 'name', container.raw, 'title', 0.7);
  }

  // ── Evjarat ──────────────────────────────────────────────────────────────
  const structVintage = numberFrom(structured['vintage'] ?? structured['year']);
  if (structVintage && structVintage >= 1900 && structVintage <= new Date().getUTCFullYear() + 2) {
    identity.vintageValue = Math.round(structVintage);
    identity.vintageStatus = 'vintage';
    evidence['vintage'] = ev('vintage', identity.vintageValue, String(structVintage), 'structured.vintage', String(structVintage), 'platform_api', 0.97);
  } else {
    const fromSpec = specText ? parseVintage(specText, 'spec') : null;
    const fromName = parseVintage(name, 'name');
    const chosen = fromSpec?.value ? fromSpec : fromName;
    if (chosen?.value) {
      identity.vintageValue = chosen.value;
      identity.vintageStatus = 'vintage';
      evidence['vintage'] = ev('vintage', chosen.value, chosen.rawMatch, chosen.source === 'spec' ? 'specs' : 'name', chosen.rawMatch, chosen.source === 'spec' ? 'spec_table' : 'title', chosen.confidence);
    } else if (chosen?.status === 'non_vintage') {
      identity.vintageStatus = 'non_vintage';
      evidence['vintage'] = ev('vintage', 'non_vintage', chosen.rawMatch, 'name', chosen.rawMatch, 'title', chosen.confidence);
    } else if (fromName.candidates.length > 1) {
      warnings.push(`Tobb lehetseges evjarat a nevben: ${fromName.candidates.join(', ')} - review szukseges.`);
    }
    // Az URL-bol kinyert ev legfeljebb gyenge jelzes (spec 13.5)
    if (identity.vintageValue === null && source.url) {
      const fromUrl = parseVintage(source.url, 'url');
      if (fromUrl.value) {
        warnings.push(`Az URL evszamot tartalmaz (${fromUrl.value}), de ez onmagaban nem bizonyitek. A mezo unknown marad.`);
      }
    }
  }

  // ── Korjeloles ───────────────────────────────────────────────────────────
  const age = parseAgeStatement(combined);
  if (age.years) {
    identity.ageStatementYears = age.years;
    evidence['ageStatementYears'] = ev('ageStatementYears', age.years, age.rawMatch, 'name', age.rawMatch, 'title', age.confidence);
  }

  // ── Puttony ──────────────────────────────────────────────────────────────
  const putt = parsePuttony(combined);
  if (putt.value) {
    identity.puttony = putt.value;
    evidence['puttony'] = ev('puttony', putt.value, putt.rawMatch, 'name', putt.rawMatch, 'title', 0.9);
  }

  // ── ABV ──────────────────────────────────────────────────────────────────
  const structAbv = numberFrom(structured['abv'] ?? structured['alcohol'] ?? structured['alcoholPercent']);
  if (structAbv && structAbv > 0 && structAbv <= 100) {
    identity.abvPercent = structAbv;
    evidence['abvPercent'] = ev('abvPercent', structAbv, String(structAbv), 'structured.abv', String(structAbv), 'platform_api', 0.95);
  } else {
    const abv = parseAbv(combined);
    if (abv.value !== null) {
      identity.abvPercent = abv.value;
      evidence['abvPercent'] = ev('abvPercent', abv.value, abv.raw, specText ? 'specs' : 'name', abv.raw, specText ? 'spec_table' : 'title', 0.85);
    }
  }

  // ── Identitashordozo kifejezesek ─────────────────────────────────────────
  const dosage = firstMatch(combinedNorm, DOSAGE_TERMS);
  if (dosage) {
    identity.dosageStyle = dosage.value;
    evidence['dosageStyle'] = ev('dosageStyle', dosage.value, dosage.raw, 'name', dosage.raw, 'title', 0.88);
  }
  const sweet = firstMatch(combinedNorm, SWEETNESS_TERMS);
  if (sweet) {
    identity.sweetness = sweet.value;
    evidence['sweetness'] = ev('sweetness', sweet.value, sweet.raw, 'name', sweet.raw, 'title', 0.75);
  }
  const colour = firstMatch(combinedNorm, COLOUR_TERMS);
  if (colour) {
    identity.colour = colour.value;
    evidence['colour'] = ev('colour', colour.value, colour.raw, 'name', colour.raw, 'title', 0.75);
  }
  const cask = firstMatch(combinedNorm, CASK_TERMS);
  if (cask) {
    identity.caskFinish = cask.value;
    evidence['caskFinish'] = ev('caskFinish', cask.value, cask.raw, 'name', cask.raw, 'title', 0.85);
  }
  const edition = firstMatch(combinedNorm, EDITION_TERMS);
  if (edition) {
    identity.edition = edition.value;
    evidence['edition'] = ev('edition', edition.value, edition.raw, 'name', edition.raw, 'title', 0.88);
  }
  const fruit = firstMatch(combinedNorm, FRUIT_TERMS);
  if (fruit && (identity.categoryKey === 'palinka' || /palinka/.test(combinedNorm))) {
    identity.fruit = fruit.value;
    evidence['fruit'] = ev('fruit', fruit.value, fruit.raw, 'name', fruit.raw, 'title', 0.85);
  }

  // ── GTIN / SKU ───────────────────────────────────────────────────────────
  const gtinRaw = firstString(structured['gtin'], structured['gtin13'], structured['ean'], structured['barcode'], source.specs?.['EAN'], source.specs?.['Vonalkod']);
  if (gtinRaw) {
    const digits = String(gtinRaw).replace(/\D/g, '');
    if (digits.length >= 8) {
      identity.gtin = digits;
      evidence['gtin'] = ev('gtin', digits, String(gtinRaw), 'structured.gtin', String(gtinRaw), 'jsonld', 0.95);
    }
  }
  const skuRaw = firstString(structured['sku'], structured['mpn'], source.specs?.['Cikkszam']);
  if (skuRaw) {
    identity.sku = String(skuRaw).trim();
    evidence['sku'] = ev('sku', identity.sku, String(skuRaw), 'structured.sku', String(skuRaw), 'jsonld', 0.9);
  }

  // ── Expression: a nevbol a marka es a strukturalt jelzok levonasa utan ──
  identity.expression = deriveExpression(name, identity);
  if (identity.expression) {
    evidence['expression'] = ev('expression', identity.expression, name, 'name', identity.expression, 'derived', 0.72);
  }

  // ── Regio / orszag a specekbol ───────────────────────────────────────────
  const region = firstString(structured['region'], source.specs?.['Borvidek'], source.specs?.['Régió'], source.specs?.['Regio']);
  if (region) {
    identity.region = cleanText(String(region));
    evidence['region'] = ev('region', identity.region, String(region), 'specs.region', String(region), 'spec_table', 0.85);
  }
  const country = firstString(structured['country'], source.specs?.['Orszag'], source.specs?.['Ország']);
  if (country) {
    identity.countryCode = cleanText(String(country));
    evidence['countryCode'] = ev('countryCode', identity.countryCode, String(country), 'specs.country', String(country), 'spec_table', 0.85);
  }
  const grapes = firstString(structured['grape'], source.specs?.['Szolofajta'], source.specs?.['Szőlőfajta'], source.specs?.['Fajta']);
  if (grapes) {
    identity.grapeVarieties = String(grapes).split(/[,;/]|\bes\b|\bés\b/).map((g) => cleanText(g)).filter(Boolean);
    if (identity.grapeVarieties.length) {
      evidence['grapeVarieties'] = ev('grapeVarieties', identity.grapeVarieties, String(grapes), 'specs.grape', String(grapes), 'spec_table', 0.85);
    }
  }

  // ── Belso ellentmondas ellenorzese ───────────────────────────────────────
  if (identity.vintageStatus === 'non_vintage' && identity.vintageValue !== null) {
    warnings.push('A forras egyszerre jelez NV statuszt es konkret evjaratot - ellentmondas.');
  }
  if (nameNorm.includes('magnum') && identity.volumeMl && identity.volumeMl < 1500) {
    warnings.push(`A nev "magnum"-ot tartalmaz, de a kinyert kiszereles ${identity.volumeMl} ml - ellentmondas.`);
  }

  return { identity, evidence, warnings };
}

/**
 * Az expression (tetel) szarmaztatasa: a nevbol levonjuk azokat a reszeket,
 * amelyeket mar kulon mezokent kinyertunk. NEM dobunk el identitashordozo
 * szavakat (spec 13.2) - azok kulon mezoben is szerepelnek, es itt maradnak.
 */
export function deriveExpression(name: string, identity: IdentityFields): string | null {
  let s = ` ${searchNorm(name)} `;
  const removals: string[] = [];
  if (identity.producer) removals.push(searchNorm(identity.producer));
  if (identity.brand) removals.push(searchNorm(identity.brand));
  for (const r of removals) {
    if (!r) continue;
    s = s.split(` ${r} `).join(' ');
  }
  // Evjarat, kiszereles es darabszam kivonasa (ezek kulon mezok)
  s = s.replace(/\b(19|20)\d{2}\b/g, ' ');
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|cl|dl|l|liter|litre|ltr)\b/g, ' ');
  s = s.replace(/\b\d{1,3}\s*x\s*\d+(?:[.,]\d+)?\s*(?:ml|cl|dl|l)\b/g, ' ');
  s = s.replace(/\b\d{1,2}\s*(?:db|palack|uveg)\b/g, ' ');
  s = s.replace(/\b\d{1,2}(?:[.,]\d{1,2})?\s*%\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length >= 2 ? s : null;
}

function numberFrom(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number.parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/**
 * Kinyeresi minosegi pontszam (spec 12.5).
 * Figyelembe veszi: a kotelezo mezok lefedettseget, a forras erosseget,
 * a belso ellentmondasokat es a strukturalt/lathato adat egyezeset.
 */
export function computeExtractionQuality(
  evidence: EvidenceMap,
  requiredFields: string[],
  opts: { warnings?: string[]; priceAndProductSameVariant?: boolean } = {},
): number {
  const required = requiredFields.map((f) => (f === 'vintageValue' ? 'vintage' : f));
  let known = 0;
  let strengthSum = 0;
  for (const f of required) {
    const e = evidence[f];
    if (e) {
      known++;
      strengthSum += e.confidence;
    }
  }
  const coverage = required.length ? known / required.length : 0;
  const avgStrength = known ? strengthSum / known : 0;

  let score = 0.55 * coverage + 0.35 * avgStrength;

  // Strukturalt forras bonusz
  const structuredHits = Object.values(evidence).filter(
    (e) => e.method === 'platform_api' || e.method === 'jsonld' || e.method === 'app_state',
  ).length;
  score += Math.min(0.1, structuredHits * 0.02);

  // Ellentmondas buntetes
  const warnings = opts.warnings ?? [];
  score -= Math.min(0.3, warnings.length * 0.12);

  if (opts.priceAndProductSameVariant === false) score -= 0.2;

  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000));
}
