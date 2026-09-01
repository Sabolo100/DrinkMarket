/**
 * XML sitemap es sitemap index feldolgozas (spec 11.2/3).
 * Fuggosegmentes, tolerans parser: a webshopok sitemapjai gyakran
 * szabalytalanok (BOM, hibas namespace, HTML-be agyazott XML).
 */

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SitemapParseResult {
  kind: 'index' | 'urlset' | 'unknown';
  entries: SitemapEntry[];
  /** Sitemap index eseten a gyerek sitemapok. */
  children: SitemapEntry[];
}

const LOC_RE = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
const URL_BLOCK_RE = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
const SITEMAP_BLOCK_RE = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;

function tagValue(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
  return m?.[1]?.trim() || undefined;
}

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export function parseSitemap(xml: string): SitemapParseResult {
  const text = xml.replace(/^﻿/, '');
  const isIndex = /<sitemapindex\b/i.test(text) || /<sitemap>\s*<loc>/i.test(text);

  if (isIndex) {
    const children: SitemapEntry[] = [];
    SITEMAP_BLOCK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SITEMAP_BLOCK_RE.exec(text)) !== null) {
      const block = m[1] ?? '';
      const loc = tagValue(block, 'loc');
      if (loc) children.push({ loc: decode(loc), lastmod: tagValue(block, 'lastmod') });
    }
    if (!children.length) {
      LOC_RE.lastIndex = 0;
      let l: RegExpExecArray | null;
      while ((l = LOC_RE.exec(text)) !== null) {
        if (l[1]) children.push({ loc: decode(l[1]) });
      }
    }
    return { kind: 'index', entries: [], children };
  }

  const entries: SitemapEntry[] = [];
  URL_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_BLOCK_RE.exec(text)) !== null) {
    const block = m[1] ?? '';
    const loc = tagValue(block, 'loc');
    if (!loc) continue;
    const priority = tagValue(block, 'priority');
    entries.push({
      loc: decode(loc),
      lastmod: tagValue(block, 'lastmod'),
      changefreq: tagValue(block, 'changefreq'),
      priority: priority ? Number.parseFloat(priority) : undefined,
    });
  }

  if (!entries.length) {
    LOC_RE.lastIndex = 0;
    let l: RegExpExecArray | null;
    while ((l = LOC_RE.exec(text)) !== null) {
      if (l[1]) entries.push({ loc: decode(l[1]) });
    }
  }

  return { kind: entries.length ? 'urlset' : 'unknown', entries, children: [] };
}

/** A robots.txt-ben hirdetett sitemapok. */
export function sitemapsFromRobots(robotsTxt: string): string[] {
  const out: string[] = [];
  for (const line of robotsTxt.split(/\r?\n/)) {
    const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

/**
 * Az utvonal szegmensei kisbetusen. Ez a kulcs: a korabbi valtozat SZOVEGES
 * reszletet keresett, ezert a '/cimke/' minta nem fogta meg a
 * '/termekcimke/'-t - a "cimke" elott ott a "termek" szo vege, nem perjel.
 * Ugyanigy csuszott at a WooCommerce angol alapertelmezese, a '/product-tag/'.
 */
function pathSegments(url: string): string[] {
  let path = url;
  try { path = new URL(url).pathname; } catch { /* relativ URL: maradjon a nyers */ }
  return path.toLowerCase().split('/').filter(Boolean);
}

/**
 * Termekoldalt jelzo utszakaszok. Ha ezek barmelyike szerepel, az oldal termek
 * - meg akkor is, ha az utban archivumra utalo szo is van. Ez tartja meg a
 * Shopify '/collections/<gyujtemeny>/products/<termek>' formajat.
 */
const PRODUCT_SEGMENTS = new Set([
  'termek', 'termekek', 'product', 'products', 'item', 'bolt-termek',
]);

/**
 * Archivumot jelzo utszakaszok: cimke-, kategoria-, szerzo- es lapozooldalak.
 * Ezek listak, nem termekek - a rajtuk levo <h1> viszont nevnek latszik, ezert
 * a kinyeresi oldal onmagaban nem veszi eszre oket.
 *
 * Szandekosan NEM szerepel itt a marka/gyarto: azok nemely boltban valodi
 * termekutvonal reszei, es egy tevesen kizart termek nema adatvesztes.
 */
const ARCHIVE_SEGMENTS = new Set([
  'termekcimke', 'termek-cimke', 'product-tag', 'tag', 'tags', 'cimke', 'cimkek',
  'termekkategoria', 'termek-kategoria', 'product-category', 'product-cat',
  'kategoria', 'kategoriak', 'category', 'categories',
  'szerzo', 'author', 'page', 'oldal', 'lapozo',
]);

/** Nyilvanvaloan nem termek utak es fajltipusok. */
const GENERIC_EXCLUDES = [
  '/blog/', '/hir', '/news', '/cikk', '/kosar', '/cart', '/checkout',
  '/fiok', '/account', '/login', '/regisztr', '/kapcsolat', '/contact',
  '/adatvedelem', '/aszf', '/szallitas', '/rolunk', '/about',
  '/gyik', '/faq', '.jpg', '.png', '.pdf', '/wp-content/', '/wp-json/',
];

/**
 * Termek-URL-e? Forrasonkent felulirhato mintakkal.
 * A vak szures veszelyes, ezert alapertelmezesben megengedo - de az
 * archivumoldalakat kizarjuk, mert azok termekkent felveve megmergeznek a
 * katalogust: a cimke neve ("badacsony") lenne a "terméknev".
 */
export function looksLikeProductUrl(url: string, patterns: { include?: string[]; exclude?: string[] } = {}): boolean {
  const u = url.toLowerCase();

  // A forrasspecifikus konfiguracio mindent felulir.
  for (const ex of patterns.exclude ?? []) {
    if (new RegExp(ex, 'i').test(u)) return false;
  }
  if (patterns.include?.length) {
    return patterns.include.some((inc) => new RegExp(inc, 'i').test(u));
  }

  const segments = pathSegments(url);
  if (segments.some((seg) => PRODUCT_SEGMENTS.has(seg))) return true;
  if (segments.some((seg) => ARCHIVE_SEGMENTS.has(seg))) return false;
  return !GENERIC_EXCLUDES.some((p) => u.includes(p));
}
