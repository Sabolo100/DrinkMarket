import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { SpreadRail } from '@/components/SpreadRail';
import { DataQualityChip, ShopDot } from '@/components/Signals';
import { apiSafe, ago, huf, num, pct, volume } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Offer {
  shopId: string; shopKey: string; shopName: string; shopColor: string | null;
  priceHuf: number; onSale: boolean; rank: number | null; stale: boolean;
  inStock: boolean | null; matchStatus: string; url: string;
  observedAt: string; deltaToMinPct: number | null;
}

interface Row {
  canonical_variant_id: string; canonical_display_name: string;
  category_key: string; category_name: string;
  vintage_value: number | null; vintage_status: string; volume_ml: number | null;
  pack_count: number; packaging_type: string; variant_status: string;
  brand_name: string | null; producer_name: string | null; tracked: boolean;
  offer_count: number | null; shop_count: number | null;
  min_price_huf: number | null; max_price_huf: number | null; median_price_huf: number | null;
  spread_pct: number | null; data_quality: string; last_change_at: string | null;
  offers: Offer[] | null;
}

export default async function ProductsPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) qs.set(k, v);
  qs.set('pageSize', qs.get('pageSize') ?? '50');

  const [data, categories] = await Promise.all([
    apiSafe<{ items: Row[]; total: number; page: number; pageSize: number; hasMore: boolean }>(
      `/products?${qs.toString()}`,
      { items: [], total: 0, page: 1, pageSize: 50, hasMore: false }),
    apiSafe<{ items: Array<{ key: string; name_hu: string }> }>('/categories', { items: [] }),
  ]);

  return (
    <>
      <PageHead
        title="Kanonikus termékkatalógus"
        lede={
          <>Minden sor egy pontosan meghatározott, eladható termékváltozat. A katalógus
          webshop-független: nem attól lesz egy termék összehasonlítható, hogy valamelyik
          bolt forgalmazza-e.</>
        }
        actions={<Link className="btn btn-sm btn-primary" href="/import">Import indítása</Link>}
      />

      <form method="get" className="toolbar">
        <div className="grow">
          <input type="search" name="q" defaultValue={String(sp['q'] ?? '')}
                 placeholder="Név, márka, borászat vagy EAN…" aria-label="Keresés" />
        </div>
        <select name="category" defaultValue={String(sp['category'] ?? '')} style={{ width: 'auto' }}
                aria-label="Kategória">
          <option value="">Minden kategória</option>
          {categories.items.map((c) => <option key={c.key} value={c.key}>{c.name_hu}</option>)}
        </select>
        <select name="status" defaultValue={String(sp['status'] ?? '')} style={{ width: 'auto' }}
                aria-label="Állapot">
          <option value="">Minden állapot</option>
          <option value="active">Jóváhagyott</option>
          <option value="proposed">Javasolt</option>
          <option value="suspended">Felfüggesztett</option>
        </select>
        <select name="minOffers" defaultValue={String(sp['minOffers'] ?? '')} style={{ width: 'auto' }}
                aria-label="Minimum ajánlat">
          <option value="">Bármennyi ajánlat</option>
          <option value="1">Van ajánlat</option>
          <option value="2">Legalább 2 ajánlat</option>
        </select>
        <select name="tracked" defaultValue={String(sp['tracked'] ?? '')} style={{ width: 'auto' }}
                aria-label="Figyelőlista">
          <option value="">Figyelt és nem figyelt</option>
          <option value="true">Csak figyelt</option>
          <option value="false">Csak nem figyelt</option>
        </select>
        <button className="btn btn-sm btn-primary" type="submit">Szűrés</button>
        <div className="spacer" />
        <span className="label num">{num(data.total)} változat</span>
      </form>

      {data.items.length === 0 ? (
        <div className="empty">
          <div className="display">Üres a katalógus</div>
          <p style={{ fontSize: 13 }}>
            Vigyél fel terméket <Link href="/import">importtal</Link>, vagy indíts
            felderítést a <Link href="/webshopok">webshopokon</Link> — a rendszer a talált
            listingekből is javasol kanonikus változatot.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th className="sticky-col">Termékváltozat</th>
                <th>Kategória</th>
                <th className="right">Évjárat</th>
                <th className="right">Kiszerelés</th>
                <th style={{ minWidth: 150 }}>Piaci szóródás</th>
                <th className="right">Legolcsóbb</th>
                <th className="right">Medián</th>
                <th className="right">Szóródás</th>
                <th className="right">Boltok</th>
                <th>Minőség</th>
                <th>Változás</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={row.canonical_variant_id}>
                  <td className="sticky-col">
                    <Link href={`/termek/${row.canonical_variant_id}`}
                          style={{ fontWeight: 500, color: 'var(--ink)' }}>
                      {row.canonical_display_name}
                    </Link>
                    <div className="cell-note">
                      {row.producer_name ?? row.brand_name ?? '—'}
                      {row.tracked && <span className="chip chip-wine" data-glyph="★" style={{ marginLeft: 6 }}>figyelt</span>}
                      {row.variant_status === 'proposed' && (
                        <span className="chip chip-review" data-glyph="·" style={{ marginLeft: 6 }}>javasolt</span>
                      )}
                    </div>
                  </td>
                  <td style={{ fontSize: 12 }}>{row.category_name}</td>
                  <td className="right num">
                    {row.vintage_value ?? (row.vintage_status === 'non_vintage' ? 'NV' : '—')}
                  </td>
                  <td className="right num">{volume(row.volume_ml, row.pack_count)}</td>
                  <td>
                    <SpreadRail
                      offers={(row.offers ?? []).map((o) => ({
                        shopId: o.shopId, shopName: o.shopName, shopColor: o.shopColor,
                        priceHuf: o.priceHuf, rank: o.rank, stale: o.stale,
                      }))}
                      min={row.min_price_huf} max={row.max_price_huf} median={row.median_price_huf}
                      showBounds={false}
                    />
                  </td>
                  <td className="right"><span className="price price-lead">{huf(row.min_price_huf)}</span></td>
                  <td className="right"><span className="price">{huf(row.median_price_huf)}</span></td>
                  <td className="right num">{row.spread_pct !== null ? pct(row.spread_pct) : '—'}</td>
                  <td className="right num">
                    {row.shop_count ?? 0}
                    {(row.shop_count ?? 0) > 0 && (
                      <div className="cell-note row-tight" style={{ gap: 2, justifyContent: 'flex-end' }}>
                        {(row.offers ?? []).slice(0, 6).map((o) => (
                          <ShopDot key={o.shopId} color={o.shopColor} name={o.shopName} />
                        ))}
                      </div>
                    )}
                  </td>
                  <td>{row.offer_count ? <DataQualityChip quality={row.data_quality} /> : <span className="chip chip-neutral" data-glyph="·">nincs ajánlat</span>}</td>
                  <td className="freshness">{ago(row.last_change_at)}</td>
                </tr>
              ))}
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
          {data.page > 1 && <PageLink sp={sp} page={data.page - 1} label="← Előző" />}
          {data.hasMore && <PageLink sp={sp} page={data.page + 1} label="Következő →" />}
        </div>
      )}
    </>
  );
}

function PageLink({
  sp, page, label,
}: { sp: Record<string, string | string[] | undefined>; page: number; label: string }) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) qs.set(k, v);
  qs.set('page', String(page));
  return <Link className="btn btn-sm" href={`/termekek?${qs.toString()}`}>{label}</Link>;
}
