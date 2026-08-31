/**
 * Identitasfingerprint (spec 17.2).
 *
 * A fingerprint a STABIL identitasmezokbol keszul. Az ARVALTOZAS NEM
 * modositja. A lenyeges nev- vagy attributumvaltozas igen -> mapping_drift.
 */
import { createHash } from 'node:crypto';
import type { IdentityFields } from '@radovin/contracts';
import { searchNorm } from '../normalization/text.js';

export interface FingerprintInput {
  platformProductId?: string | null;
  platformVariantId?: string | null;
  identity: IdentityFields;
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return '~';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (Array.isArray(v)) return v.map((x) => searchNorm(String(x))).sort().join('+') || '~';
  const s = searchNorm(String(v));
  return s || '~';
}

/**
 * A strukturalt identitasmezokbol szamolt hash. Ez donti el, hogy egy korabban
 * parositott listing ugyanaz a termek maradt-e.
 */
export function identityHash(input: FingerprintInput): string {
  const i = input.identity;
  const parts = [
    'v2',
    norm(input.platformProductId),
    norm(input.platformVariantId),
    norm(i.producer ?? i.brand),
    norm(i.brand),
    norm(i.expression),
    norm(i.vintageValue),
    norm(i.vintageStatus),
    norm(i.ageStatementYears),
    norm(i.volumeMl),
    norm(i.packCount),
    norm(i.packagingType),
    norm(i.edition),
    norm(i.caskFinish),
    norm(i.dosageStyle),
    norm(i.puttony),
    norm(i.gtin),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40);
}

/**
 * Nyers forras-fingerprint: a lathato terméknevbol es a fo strukturalt
 * mezokbol. Ez erzekenyebb, mint az identityHash - kis tipografiai valtozas is
 * elmozdithatja, ezert a drift-kezeles kulon vizsgalja (spec 17.3).
 */
export function sourceFingerprint(rawName: string, extra: Record<string, unknown> = {}): string {
  const keys = Object.keys(extra).sort();
  const payload = [searchNorm(rawName), ...keys.map((k) => `${k}=${norm(extra[k])}`)].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 40);
}

/** Tartalom-hash a valtozasdetektalashoz (ar nelkul!). */
export function contentHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 40);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export type DriftSeverity = 'none' | 'cosmetic' | 'significant' | 'product_changed';

export interface DriftResult {
  severity: DriftSeverity;
  changedFields: string[];
  message: string;
  blocksPricePublication: boolean;
}

/**
 * Drift-kezeles (spec 17.3).
 *  - kis tipografiai valtozas: automatikusan elfogadhato;
 *  - vintage / volume / edition / pack / packaging valtozas: azonnal blokkolja
 *    az ar publikalasat;
 *  - masik termekke valas: uj listing vagy review.
 */
const BLOCKING_FIELDS = new Set([
  'vintageValue', 'vintageStatus', 'volumeMl', 'packCount', 'packagingType',
  'edition', 'ageStatementYears', 'caskFinish', 'dosageStyle', 'puttony', 'gtin',
]);

const IDENTITY_CORE = new Set(['producer', 'brand', 'expression']);

export function detectDrift(
  before: IdentityFields,
  after: IdentityFields,
  opts: { beforeName?: string; afterName?: string } = {},
): DriftResult {
  const changed: string[] = [];
  const fields: Array<keyof IdentityFields> = [
    'producer', 'brand', 'expression', 'vintageValue', 'vintageStatus',
    'ageStatementYears', 'volumeMl', 'packCount', 'packagingType', 'edition',
    'caskFinish', 'dosageStyle', 'puttony', 'gtin', 'abvPercent', 'categoryKey',
  ];
  for (const f of fields) {
    const a = norm(before[f]);
    const b = norm(after[f]);
    // Az 'unknown' -> ismert atmenet dusitas, nem drift.
    if (a === '~' && b !== '~') continue;
    if (a !== b) changed.push(String(f));
  }

  if (changed.length === 0) {
    // Nev valtozas onmagaban: kozmetikai, ha a normalizalt nev hasonlo marad
    if (opts.beforeName && opts.afterName) {
      const a = searchNorm(opts.beforeName);
      const b = searchNorm(opts.afterName);
      if (a !== b) {
        return {
          severity: 'cosmetic', changedFields: ['rawName'],
          message: 'A termeknev valtozott, de az identitasmezok azonosak maradtak.',
          blocksPricePublication: false,
        };
      }
    }
    return { severity: 'none', changedFields: [], message: 'Nincs identitas-eltolodas.', blocksPricePublication: false };
  }

  const blocking = changed.filter((f) => BLOCKING_FIELDS.has(f));
  const core = changed.filter((f) => IDENTITY_CORE.has(f));

  if (core.length >= 2 || changed.includes('categoryKey')) {
    return {
      severity: 'product_changed',
      changedFields: changed,
      message: `Az URL mogotti termek valoszinuleg masik termekre valtott (${changed.join(', ')}).`,
      blocksPricePublication: true,
    };
  }
  if (blocking.length > 0 || core.length > 0) {
    return {
      severity: 'significant',
      changedFields: changed,
      message: `Identitas-eltolodas a kovetkezo mezokben: ${changed.join(', ')}.`,
      blocksPricePublication: true,
    };
  }
  return {
    severity: 'cosmetic',
    changedFields: changed,
    message: `Kisebb attributumvaltozas: ${changed.join(', ')}.`,
    blocksPricePublication: false,
  };
}
