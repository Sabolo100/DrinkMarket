import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { ShopDot } from '@/components/Signals';
import { apiSafe, ago, huf, num, volume } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Webshop-terméktár (spec 26.).
 *
 * MINDEN megtalált webshoptermék megtekinthető akkor is, ha még nem
 * kapcsolódik más webshop termékéhez vagy jóváhagyott kanonikus változathoz.
 * Az index lapozott; az ártörténet külön kérésre töltődik.
 */

const CLUSTER: Record<string, { label: string; tone: string; glyph: string; help: string }> = {
  unclustered:  { label: 'Nincs klaszterezve', tone: 'chip-neutral', glyph: '·', help: 'Még nem kapcsolódik kanonikus termékváltozathoz.' },
  searching:    { label: 'Keresés folyik', tone: 'chip-neutral', glyph: '◌', help: 'A klaszterezés éppen fut.' },
  clustered:    { label: 'Klaszterezve', tone: 'chip-verified', glyph: '✓', help: 'Igazolt kapcsolat egy kanonikus változattal.' },
  needs_review: { label: 'Ellenőrzés kell', tone: 'chip-review', glyph: '?', help: 'Van jelölt, de emberi döntés szükséges.' },
  rejected_all: { label: 'Minden jelölt kizárva', tone: 'chip-rejected', glyph: '×', help: 'Egyetlen kanonikus változat sem felel meg.' },
  drifted:      { label: 'Identitás-eltolódás', tone: 'chip-rejected', glyph: '⇄', help: 'A termékoldal identitása megváltozott.' },
};

export default async function CatalogPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const shopId = typeof sp['shopId'] === 'string' ? sp['shopId']
    : typeof sp['anchorShopId'] === 'string' ? sp['anchorShopId'] : '';

  const [shops, categories] = await Promise.all([
    apiSafe<{ items: Array<{ id: string; name: string; brand_color: string | null; listings_active: number }> }>(
      '/shops', { items: [] }),
    apiSafe<{ items: Array<{ key: string; name_hu: string }> }>('/categories', { items: [] }),
  ]);

  const selectedShop = shops.items.find((s) => s.id === shopId) ?? shops.items[0];

  if (!selectedShop) {
    return (
      <>
        <PageHead title="Webshop-terméktár" />
        <div className="empty">
          <div className="display">Nincs regisztrált webshop</div>
        </div>
      </>
    );
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === 'string' && v && k !== 'shopId' && k !== 'anchorShopId') qs.set(k, v);
  }
  qs.set('pageSize', qs.get('pageSize') ?? '50');

  const data = await apiSafe<{
    items: Array<Record<string, unknown>>;
    total: number; page: number; pageSize: number; hasMore: boolean;
  }>(`/shops/${selectedShop.id}/listings?${qs.toString()}`,
    { items: [], total: 0, page: 1, pageSize: 50, hasMore: false });

  return (
    <>
      <PageHead
        title="Webshop-terméktár"
        lede={
          <>A crawling során talált minden termék megjelenik itt — akkor is, ha még
          egyetlen másik webshop termékéhez sem párosítható, és akkor is, ha a RADOVIN
          nem forgalmazza.</>
        }
      />

      <form method="get" className="toolbar">
        <select name="shopId" defaultValue={selectedShop.id} style={{ width: 'auto', minWidth: 180 }}
                aria-label="Webshop">
          {shops.items.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({num(s.listings_active)})</option>
          ))}
        </select>
        <div className="grow">
          <input type="search" name="q" defaultValue={String(sp['q'] ?? '')}
                 placeholder="Terméknév, cikkszám vagy EAN…" aria-label="Keresés" />
        </div>
        <select name="cluster" defaultValue={String(sp['cluster'] ?? '')} style={{ width: 'auto' }}
                aria-label="Klaszterezési állapot">
          <option value="">Minden állapot</option>
          {Object.entries(CLUSTER).map(([key, c]) => (
            <option key={key} value={key}>{c.label}</option>
          ))}
        </select>
        <select name="category" defaultValue={String(sp['category'] ?? '')} style={{ width: 'auto' }}
                aria-label="Kategória">
          <option value="">Minden kategória</option>
          {categories.items.map((c) => <option key={c.key} value={c.key}>{c.name_hu}</option>)}
        </select>
        <select name="inStock" defaultValue={String(sp['inStock'] ?? '')} style={{ width: 'auto' }}
                aria-label="Készlet">
          <option value="">Készlettől függetlenül</option>
          <option value="true">Csak készleten</option>
          <option value="false">Csak elfogyott</option>
        </select>
        <button className="btn btn-sm btn-primary" type="submit">Szűrés</button>
        <div className="spacer" />
        <span className="label num">{num(data.total)} listing</span>
      </form>

      {data.items.length === 0 ? (
        <div className="empty">
          <div className="display">Nincs listing ebben a webshopban</div>
          <p style={{ fontSize: 13 }}>
            Indíts felderítést a <Link href={`/webshopok/${selectedShop.id}`}>webshop oldalán</Link>.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th style={{ width: 44 }}></th>
                <th className="sticky-col" style={{ left: 44 }}>A webshop terméknevé</th>
                <th>Klaszter</th>
                <th>Kanonikus párja</th>
                <th className="right">Ár</th>
                <th className="right">Évjárat</th>
                <th className="right">Kiszerelés</th>
                <th className="right">Kinyerés</th>
                <th>Készlet</th>
                <th>Első észlelés</th>
                <th>Utolsó ellenőrzés</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((l) => {
                const cluster = CLUSTER[String(l['cluster_status'])] ?? CLUSTER['unclustered']!;
                const quality = Number(l['extraction_quality'] ?? 0);
                return (
                  <tr key={String(l['id'])}>
                    <td>
                      {l['image_url']
                        ? <img className="thumb" src={String(l['image_url'])} alt="" loading="lazy" />
                        : <div className="thumb" aria-hidden="true" />}
                    </td>
                    <td className="sticky-col" style={{ left: 44 }}>
                      <a href={String(l['canonical_url'])} target="_blank" rel="noopener noreferrer nofollow"
                         style={{ fontWeight: 500, color: 'var(--ink)' }}>
                        {String(l['raw_name'])} ↗
                      </a>
                      <div className="cell-note">
                        {[l['sku'] ? `cikkszám: ${l['sku']}` : null,
                          l['gtin'] ? `EAN: ${l['gtin']}` : null,
                          l['category_name']].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      <span className={`chip ${cluster.tone}`} data-glyph={cluster.glyph} title={cluster.help}>
                        {cluster.label}
                      </span>
                    </td>
                    <td>
                      {l['canonical_variant_id'] ? (
                        <Link href={`/termek/${l['canonical_variant_id']}`} style={{ fontSize: 12 }}>
                          {String(l['canonical_display_name'])}
                        </Link>
                      ) : <span className="faint" style={{ fontSize: 12 }}>—</span>}
                    </td>
                    <td className="right">
                      <span className={l['comparable'] ? 'price' : 'price price-stale'}>
                        {huf(l['price_huf'] as number)}
                      </span>
                      {l['comparable'] === false && (
                        <div className="cell-note" style={{ color: 'var(--brass)' }}>
                          nem összehasonlítható
                        </div>
                      )}
                    </td>
                    <td className="right num">{l['vintage_value'] ? String(l['vintage_value']) : '—'}</td>
                    <td className="right num">
                      {volume(l['volume_ml'] as number, Number(l['pack_count'] ?? 1))}
                    </td>
                    <td className="right num" title="Kinyerési minőség 0 és 1 között.">
                      <span style={{ color: quality < 0.6 ? 'var(--rust)' : quality < 0.85 ? 'var(--brass)' : 'var(--verdigris)' }}>
                        {quality.toFixed(2)}
                      </span>
                    </td>
                    <td>
                      {l['availability_status'] === 'in_stock'
                        ? <span className="chip chip-verified" data-glyph="✓">készleten</span>
                        : l['availability_status'] === 'out_of_stock'
                          ? <span className="chip chip-neutral" data-glyph="⌀">elfogyott</span>
                          : <span className="chip chip-neutral" data-glyph="?">ismeretlen</span>}
                    </td>
                    <td className="freshness">{ago(l['first_seen_at'] as string)}</td>
                    <td className="freshness">{ago(l['last_checked_at'] as string)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data.total > data.pageSize && (
        <div className="pagination">
          <span className="muted num">
            {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} / {num(data.total)}
          </span>
          <div className="spacer" />
          {data.page > 1 && (
            <Link className="btn btn-sm"
                  href={`/termektar?shopId=${selectedShop.id}&page=${data.page - 1}`}>← Előző</Link>
          )}
          {data.hasMore && (
            <Link className="btn btn-sm"
                  href={`/termektar?shopId=${selectedShop.id}&page=${data.page + 1}`}>Következő →</Link>
          )}
        </div>
      )}
    </>
  );
}
