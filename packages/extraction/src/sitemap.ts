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
 * Termek-URL-e? Forrasonkent felulirhato mintakkal.
 * A vak szures veszelyes, ezert alapertelmezesben megengedo.
 */
export function looksLikeProductUrl(url: string, patterns: { include?: string[]; exclude?: string[] } = {}): boolean {
  const u = url.toLowerCase();
  for (const ex of patterns.exclude ?? []) {
    if (new RegExp(ex, 'i').test(u)) return false;
  }
  if (patterns.include?.length) {
    return patterns.include.some((inc) => new RegExp(inc, 'i').test(u));
  }
  // Alap heurisztika: a nyilvanvaloan nem termek utakat zarjuk ki
  const genericExcludes = [
    '/blog/', '/hir', '/news', '/cikk', '/kosar', '/cart', '/checkout',
    '/fiok', '/account', '/login', '/regisztr', '/kapcsolat', '/contact',
    '/adatvedelem', '/aszf', '/szallitas', '/rolunk', '/about',
    '/gyik', '/faq', '.jpg', '.png', '.pdf', '/wp-content/', '/wp-json/',
    '/tag/', '/cimke/', '/szerzo/', '/author/', '/page/', '/oldal/',
  ];
  return !genericExcludes.some((p) => u.includes(p));
}
