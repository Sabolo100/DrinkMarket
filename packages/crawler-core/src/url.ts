/**
 * URL-kanonizalas forrasonkent (spec 11.5).
 *
 * FIGYELEM: query parameter NEM torolheto vakon, mert variansT azonosithat
 * (pl. ?variant=123 a Shopifynal). Ezert a szabaly explicit allowlist/denylist.
 */

export interface UrlCanonicalizationRule {
  /** Ezek a query parameterek MEGTARTANDOK (variansazonositok). */
  keepParams?: string[];
  /** Ezek biztonsagosan eldobhatok (kovetesi parameterek). */
  dropParams?: string[];
  /** Ha true, minden meg nem nevezett parameter eldobhato. */
  dropUnknownParams?: boolean;
  stripTrailingSlash?: boolean;
  lowercasePath?: boolean;
  stripFragment?: boolean;
  /** A hoston beluli path prefix, amit el kell tavolitani (pl. /hu). */
  stripPathPrefix?: string;
}

/** Univerzalisan biztonsagosan eldobhato kovetesi parameterek. */
export const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'dclid', 'twclid', 'ttclid', 'igshid',
  '_ga', '_gl', 'mc_cid', 'mc_eid', 'ref', 'referrer', 'source',
  'cmpid', 'campaign', 'affiliate', 'aff', 'partner',
];

/** Tipikus variansazonosito parameterek, amiket MEG KELL tartani. */
export const VARIANT_PARAMS = [
  'variant', 'variant_id', 'v', 'sku', 'attribute_pa_kiszereles',
  'attribute_kiszereles', 'attribute_pa_evjarat', 'attribute_evjarat',
  'attribute_pa_size', 'attribute_size', 'option', 'child_id', 'pid',
];

const DEFAULT_RULE: UrlCanonicalizationRule = {
  keepParams: VARIANT_PARAMS,
  dropParams: TRACKING_PARAMS,
  dropUnknownParams: false,
  stripTrailingSlash: true,
  lowercasePath: false,
  stripFragment: true,
};

export function canonicalizeUrl(rawUrl: string, rule: UrlCanonicalizationRule = {}): string {
  const r = { ...DEFAULT_RULE, ...rule };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }
  if (r.stripFragment) url.hash = '';

  let pathname = url.pathname;
  if (r.stripPathPrefix && pathname.startsWith(r.stripPathPrefix)) {
    pathname = pathname.slice(r.stripPathPrefix.length) || '/';
  }
  if (r.lowercasePath) pathname = pathname.toLowerCase();
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (r.stripTrailingSlash && pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;

  const keep = new Set((r.keepParams ?? []).map((p) => p.toLowerCase()));
  const drop = new Set((r.dropParams ?? []).map((p) => p.toLowerCase()));
  const params = [...url.searchParams.entries()];
  const kept: Array<[string, string]> = [];
  for (const [key, value] of params) {
    const k = key.toLowerCase();
    if (keep.has(k)) { kept.push([key, value]); continue; }
    if (drop.has(k)) continue;
    if (r.dropUnknownParams) continue;
    kept.push([key, value]);
  }
  // Stabil sorrend, hogy ugyanaz az URL mindig ugyanazt a kulcsot adja
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);

  return url.toString();
}

/**
 * Stabil URL-kulcs a listing egyedisegehez, ha nincs platformazonosito.
 * Host + path + a megtartott query parameterek.
 */
export function urlKey(rawUrl: string, rule: UrlCanonicalizationRule = {}): string {
  const canonical = canonicalizeUrl(rawUrl, rule);
  try {
    const u = new URL(canonical);
    const host = u.hostname.replace(/^www\./, '');
    return `${host}${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return canonical.toLowerCase();
  }
}

/** Az utolso ertelmes path szegmens (slug). */
export function slugOf(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? null;
  } catch {
    return null;
  }
}

export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, '').toLowerCase()
      === new URL(b).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
}
