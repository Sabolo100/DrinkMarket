/**
 * Fuggosegmentes HTML-elemzo segedek. Nem teljes DOM parser: celzottan azokat
 * a mintakat ismeri fel, amelyekre a termekkinyeresnek szuksege van
 * (spec 12.1). Igy nincs nehez fuggoseg a crawler hot path-jan.
 */

export interface TagMatch {
  tag: string;
  attrs: Record<string, string>;
  inner: string;
  start: number;
  end: number;
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

export function parseAttrs(attrString: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrString)) !== null) {
    const key = (m[1] ?? '').toLowerCase();
    out[key] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** Osszes megadott tag megkeresese, a belso tartalommal egyutt. */
export function findTags(html: string, tag: string): TagMatch[] {
  const out: TagMatch[] = [];
  const openRe = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
  const voidTag = /^(meta|link|img|br|hr|input|source)$/i.test(tag);
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    const attrs = parseAttrs(m[1] ?? '');
    if (voidTag) {
      out.push({ tag, attrs, inner: '', start: m.index, end: openRe.lastIndex });
      continue;
    }
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    closeRe.lastIndex = openRe.lastIndex;
    const close = closeRe.exec(html);
    const innerEnd = close ? close.index : html.length;
    out.push({
      tag, attrs,
      inner: html.slice(openRe.lastIndex, innerEnd),
      start: m.index,
      end: close ? closeRe.lastIndex : html.length,
    });
  }
  return out;
}

export function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function metaContent(html: string, matcher: (attrs: Record<string, string>) => boolean): string | null {
  for (const tag of findTags(html, 'meta')) {
    if (matcher(tag.attrs) && tag.attrs['content']) return tag.attrs['content'];
  }
  return null;
}

export function canonicalLink(html: string): string | null {
  for (const tag of findTags(html, 'link')) {
    if ((tag.attrs['rel'] ?? '').toLowerCase() === 'canonical' && tag.attrs['href']) return tag.attrs['href'];
  }
  return null;
}

export function titleText(html: string): string | null {
  const t = findTags(html, 'title')[0];
  return t ? stripTags(t.inner) : null;
}

/** Breadcrumb kinyerese JSON-LD-bol vagy tipikus DOM mintakbol. */
export function extractBreadcrumb(html: string): string[] {
  const out: string[] = [];
  for (const block of findTags(html, 'nav')) {
    const cls = (block.attrs['class'] ?? '').toLowerCase();
    const id = (block.attrs['id'] ?? '').toLowerCase();
    if (!cls.includes('breadcrumb') && !id.includes('breadcrumb')) continue;
    for (const a of findTags(block.inner, 'a')) {
      const text = stripTags(a.inner);
      if (text) out.push(text);
    }
  }
  if (out.length) return out;
  for (const block of findTags(html, 'ol')) {
    const cls = (block.attrs['class'] ?? '').toLowerCase();
    if (!cls.includes('breadcrumb')) continue;
    for (const li of findTags(block.inner, 'li')) {
      const text = stripTags(li.inner);
      if (text) out.push(text);
    }
  }
  return out;
}

/**
 * Specifikacios tablazat kinyerese. Tobb elterjedt mintat kezel:
 *  - <table><tr><th>Kulcs</th><td>Ertek</td></tr>
 *  - <dl><dt>Kulcs</dt><dd>Ertek</dd>
 *  - <li><span class="label">Kulcs</span><span>Ertek</span></li>
 */
export function extractSpecTable(html: string): Record<string, string> {
  const specs: Record<string, string> = {};

  for (const table of findTags(html, 'table')) {
    for (const row of findTags(table.inner, 'tr')) {
      const cells = [...findTags(row.inner, 'th'), ...findTags(row.inner, 'td')]
        .sort((a, b) => a.start - b.start)
        .map((c) => stripTags(c.inner));
      if (cells.length >= 2 && cells[0] && cells[1]) {
        const key = cells[0].replace(/:$/, '').trim();
        if (key.length <= 60) specs[key] = cells[1].trim();
      }
    }
  }

  for (const dl of findTags(html, 'dl')) {
    const dts = findTags(dl.inner, 'dt');
    const dds = findTags(dl.inner, 'dd');
    for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
      const key = stripTags(dts[i]!.inner).replace(/:$/, '').trim();
      const value = stripTags(dds[i]!.inner).trim();
      if (key && value && key.length <= 60) specs[key] = value;
    }
  }

  return specs;
}

/** Osszes kepforras a termekhez (elsokent az og:image, majd a fo kepek). */
export function extractImage(html: string, baseUrl: string): string | null {
  const og = metaContent(html, (a) =>
    (a['property'] ?? a['name'] ?? '').toLowerCase() === 'og:image');
  if (og) return absoluteUrl(og, baseUrl);
  for (const img of findTags(html, 'img')) {
    const src = img.attrs['src'] ?? img.attrs['data-src'] ?? '';
    const cls = (img.attrs['class'] ?? '').toLowerCase();
    const id = (img.attrs['id'] ?? '').toLowerCase();
    if (!src) continue;
    if (cls.includes('product') || id.includes('product') || cls.includes('main-image')) {
      return absoluteUrl(src, baseUrl);
    }
  }
  return null;
}

export function absoluteUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

/**
 * Beagyazott alkalmazas-state kinyerese (spec 12.1/3).
 * Ismert mintak: window.__NUXT__, __NEXT_DATA__, ShopifyAnalytics meta,
 * window.dataLayer, var product = {...}
 */
export function extractAppState(html: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const nextData = findTags(html, 'script').find((s) => s.attrs['id'] === '__NEXT_DATA__');
  if (nextData) {
    const parsed = safeJson(nextData.inner);
    if (parsed) out['__NEXT_DATA__'] = parsed;
  }

  const patterns: Array<[string, RegExp]> = [
    ['shopifyMeta', /var\s+meta\s*=\s*(\{[\s\S]*?\});\s*\n/],
    ['shopifyProduct', /window\.ShopifyAnalytics\.meta\.product\s*=\s*(\{[\s\S]*?\});/],
    ['nuxt', /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/],
    ['wcSettings', /var\s+wc_add_to_cart_params\s*=\s*(\{[\s\S]*?\});/],
    ['productJson', /"@type"\s*:\s*"Product"/],
  ];
  for (const [key, re] of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const parsed = safeJson(m[1]);
      if (parsed) out[key] = parsed;
    }
  }

  // WooCommerce variacios adat
  const variations = html.match(/data-product_variations\s*=\s*(?:"|&quot;)([\s\S]*?)(?:"|&quot;)\s*(?:>|\s)/);
  if (variations?.[1]) {
    const decoded = variations[1]
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'");
    const parsed = safeJson(decoded);
    if (parsed) out['wooVariations'] = parsed;
  }

  return out;
}

export function safeJson(text: string): unknown | null {
  const trimmed = text.trim().replace(/;$/, '');
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
