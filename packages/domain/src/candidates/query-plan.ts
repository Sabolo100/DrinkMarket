/**
 * Query-terv generalas (spec 14.2).
 *
 * A tagabb query NEM jelenti a matching szabalyok lazitasat. Csak tobb
 * jeloltet hoz, amelyekre ugyanazok a hard gate-ek futnak le.
 */
import type { IdentityFields } from '@radovin/contracts';
import { cleanText, searchNorm } from '../normalization/text.js';

export interface QueryPlanStep {
  level: number;
  query: string;
  intent: string;
  /** Ha true, a lekerdezes eleg specifikus ahhoz, hogy keves talalatot varjunk. */
  narrow: boolean;
}

export interface QueryPlanInput {
  displayName: string;
  identity: IdentityFields;
  /** Mas webshopokban mar megismert aliasok, gyartoi nevek. */
  knownAliases?: string[];
}

function fmtVolume(ml: number | null): string | null {
  if (!ml) return null;
  if (ml % 1000 === 0) return `${ml / 1000} l`;
  if (ml >= 1000) return `${(ml / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} l`;
  return `${ml} ml`;
}

/**
 * Rendezett keresesi terv szukebbtol tagabb fele.
 * Pelda (spec 14.2):
 *   1. "Gere Roka Pinot Noir 2023 0.75 l"
 *   2. "Gere Roka Pinot Noir 2023"
 *   3. "Gere Roka Pinot Noir"
 *   4. "Gere Pinot Noir 2023"
 *   5. "Gere Roka"
 */
export function buildQueryPlan(input: QueryPlanInput): QueryPlanStep[] {
  const i = input.identity;
  const brand = cleanText(i.producer ?? i.brand ?? '');
  const expression = cleanText(i.expression ?? '');
  const vintage = i.vintageValue ? String(i.vintageValue) : '';
  const age = i.ageStatementYears ? `${i.ageStatementYears} eves` : '';
  const volume = fmtVolume(i.volumeMl) ?? '';
  const edition = cleanText(i.edition ?? '');
  const display = cleanText(input.displayName);

  const steps: QueryPlanStep[] = [];
  const seen = new Set<string>();

  const push = (level: number, parts: Array<string | null | undefined>, intent: string, narrow: boolean) => {
    const q = parts.filter((p): p is string => Boolean(p && p.trim())).join(' ').replace(/\s+/g, ' ').trim();
    if (!q) return;
    const key = searchNorm(q);
    if (!key || seen.has(key)) return;
    seen.add(key);
    steps.push({ level, query: q, intent, narrow });
  };

  // 1. szint - a legszukebb: minden ismert identitaselem
  push(1, [brand, expression, edition, vintage || age, volume], 'teljes identitas', true);
  // 2. szint - kiszereles nelkul
  push(2, [brand, expression, edition, vintage || age], 'kiszereles nelkul', true);
  // 3. szint - evjarat/kor nelkul
  push(3, [brand, expression, edition], 'evjarat nelkul', true);
  // 4. szint - kiadas nelkul
  push(4, [brand, expression, vintage || age], 'kiadas nelkul', false);
  // 5. szint - a teljes megjelenitett nev (a webshop sajat kereso gyakran ezzel jobb)
  push(5, [display], 'teljes megjelenitett nev', false);
  // 6. szint - csak marka + tetel
  push(6, [brand, expression], 'marka + tetel', false);
  // 7. szint - marka + kiszereles
  push(7, [brand, volume], 'marka + kiszereles', false);
  // 8. szint - csak marka
  push(8, [brand], 'csak marka', false);

  // 9+. szint - mas forrasbol megismert aliasok (spec 16.2)
  let level = 9;
  for (const alias of input.knownAliases ?? []) {
    push(level++, [cleanText(alias), vintage || age], 'ismert alias', false);
  }

  // GTIN kulon utvonal, ha van
  if (i.gtin) push(0, [i.gtin], 'EAN/GTIN', true);

  return steps.sort((a, b) => a.level - b.level);
}

/**
 * Blocking kulcsok tobb passzban (spec 14.1/C).
 * Egyetlen szigoru kulcs hianyos mezo eseten elveszitheti a valodi talalatot,
 * ezert tobb, egymast atfedo kulcs kepzodik.
 */
export interface BlockingKey {
  pass: number;
  name: string;
  /** SQL WHERE fragmentekhez hasznalt strukturalt szurofeltetel. */
  filter: Partial<{
    brandId: string;
    producerId: string;
    categoryKey: string;
    vintageValue: number;
    volumeMl: number;
    packCount: number;
    expressionNorm: string;
    gtin: string;
    tokenSignature: string[];
  }>;
  selectivity: 'high' | 'medium' | 'low';
}

export function buildBlockingKeys(identity: IdentityFields, displayName: string): BlockingKey[] {
  const keys: BlockingKey[] = [];
  const expressionNorm = searchNorm(identity.expression ?? '');
  const tokenSignature = signatureTokens(displayName, identity);

  if (identity.gtin) {
    keys.push({ pass: 0, name: 'gtin_exact', filter: { gtin: identity.gtin }, selectivity: 'high' });
  }
  if ((identity.producerId || identity.brandId) && expressionNorm && identity.vintageValue && identity.volumeMl) {
    keys.push({
      pass: 1, name: 'producer_expression_vintage_volume', selectivity: 'high',
      filter: {
        ...(identity.producerId ? { producerId: identity.producerId } : {}),
        ...(identity.brandId ? { brandId: identity.brandId } : {}),
        expressionNorm, vintageValue: identity.vintageValue, volumeMl: identity.volumeMl,
      },
    });
  }
  if ((identity.producerId || identity.brandId) && expressionNorm && identity.volumeMl) {
    keys.push({
      pass: 2, name: 'producer_expression_volume', selectivity: 'high',
      filter: {
        ...(identity.producerId ? { producerId: identity.producerId } : {}),
        ...(identity.brandId ? { brandId: identity.brandId } : {}),
        expressionNorm, volumeMl: identity.volumeMl,
      },
    });
  }
  if ((identity.producerId || identity.brandId) && identity.vintageValue && identity.categoryKey) {
    keys.push({
      pass: 3, name: 'producer_vintage_category', selectivity: 'medium',
      filter: {
        ...(identity.producerId ? { producerId: identity.producerId } : {}),
        ...(identity.brandId ? { brandId: identity.brandId } : {}),
        vintageValue: identity.vintageValue, categoryKey: identity.categoryKey,
      },
    });
  }
  if ((identity.producerId || identity.brandId) && tokenSignature.length) {
    keys.push({
      pass: 4, name: 'producer_token_signature', selectivity: 'medium',
      filter: {
        ...(identity.producerId ? { producerId: identity.producerId } : {}),
        ...(identity.brandId ? { brandId: identity.brandId } : {}),
        tokenSignature,
      },
    });
  }
  if (identity.categoryKey && expressionNorm && identity.volumeMl) {
    keys.push({
      pass: 5, name: 'category_expression_volume', selectivity: 'medium',
      filter: { categoryKey: identity.categoryKey, expressionNorm, volumeMl: identity.volumeMl },
    });
  }
  if (identity.volumeMl && tokenSignature.length >= 2) {
    keys.push({
      pass: 6, name: 'volume_token_signature', selectivity: 'low',
      filter: { volumeMl: identity.volumeMl, tokenSignature },
    });
  }
  return keys;
}

/**
 * A nev azon tokenjei, amelyek identitast hordoznak. A puszta kereskedelmi
 * zajszavak mar korabban kikerultek; ITT nem dobunk el semmit, ami
 * identitashordozo lehet (spec 13.2).
 */
export function signatureTokens(displayName: string, identity: IdentityFields): string[] {
  const tokens = searchNorm(displayName).split(' ').filter(Boolean);
  const brandTokens = new Set(searchNorm(identity.producer ?? identity.brand ?? '').split(' ').filter(Boolean));
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (brandTokens.has(t)) continue;
    if (/^\d{4}$/.test(t)) continue;            // evjarat kulon mezo
    if (/^\d+(?:[.,]\d+)?$/.test(t)) continue;  // puszta szam
    out.push(t);
  }
  return [...new Set(out)].slice(0, 8);
}
