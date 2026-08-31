import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { SpreadRail } from '@/components/SpreadRail';
import {
  DataQualityChip, DeltaBadge, HealthChip, PriceCell, ShopDot,
} from '@/components/Signals';
import { MatrixFilters } from './MatrixFilters';
import { apiSafe, ago, huf, hufShort, num, pct, volume } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Cell {
  shopId: string; priceHuf: number; regularPriceHuf: number | null; onSale: boolean;
  rank: number | null; denominator: number | null; tied: boolean;
  inStock: boolean | null; stale: boolean; matchStatus: string;
  matchConfidence: number | null; decisionOrigin: string; url: string;
  observedAt: string; freshnessHours: number;
  deltaToMinHuf: number | null; deltaToMinPct: number | null; deltaToMedianPct: number | null;
  listingName: string; shopHealth: string;
}

interface Row {
  canonical_variant_id: string;
  canonical_display_name: string;
  category_key: string; category_name: string;
  vintage_value: number | null; vintage_status: string;
  age_statement_years: number | null; volume_ml: number | null;
  pack_count: number; packaging_type: string;
  brand_name: string | null; producer_name: string | null; tracked: boolean;
  offer_count: number | null; shop_count: number | null;
  min_price_huf: number | null; max_price_huf: number | null; median_price_huf: number | null;
  spread_huf: number | null; spread_pct: number | null;
  any_on_sale: boolean; any_stale: boolean; data_quality: string;
  last_change_at: string | null;
  cells: Record<string, Cell> | null;
  anchor: {
    price_huf: number; rank_in_market: number | null; rank_denominator: number | null;
    delta_to_min_huf: number | null; delta_to_min_pct: number | null;
    delta_to_median_pct: number | null; on_sale: boolean; stale: boolean; product_url: string;
  } | null;
}

interface ShopColumn {
  id: string; key: string; name: string; brand_color: string | null;
  health_status: string; offer_count: number;
}

export default async function DashboardPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const anchorShopId = typeof sp['anchorShopId'] === 'string' ? sp['anchorShopId'] : '';
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string' && value) qs.set(key, value);
  }
  qs.set('pageSize', qs.get('pageSize') ?? '40');

  const [summary, matrix, categories] = await Promise.all([
    apiSafe<{
      general: Record<string, number> | null;
      publication: Record<string, unknown> | null;
      shops: Array<Record<string, unknown>>;
      anchor: Record<string, number> | null;
    }>(`/dashboard/summary${anchorShopId ? `?anchorShopId=${anchorShopId}` : ''}`,
      { general: null, publication: null, shops: [], anchor: null }),
    apiSafe<{
      items: Row[]; total: number; page: number; pageSize: number; hasMore: boolean;
      shopColumns: ShopColumn[];
    }>(`/dashboard/comparison-matrix?${qs.toString()}`,
      { items: [], total: 0, page: 1, pageSize: 40, hasMore: false, shopColumns: [] }),
    apiSafe<{ items: Array<{ key: string; name_hu: string }> }>('/categories', { items: [] }),
  ]);

  const g = summary.general ?? {};
  const anchorShop = matrix.shopColumns.find((s) => s.id === anchorShopId);
  const columns = matrix.shopColumns.filter((s) => s.offer_count > 0 || s.id === anchorShopId);

  return (
    <>
      <PageHead
        title={anchorShop ? `${anchorShop.name} a piacon` : 'Ár-összehasonlítás'}
        lede={anchorShop
          ? <>A(z) <strong>{anchorShop.name}</strong> termékeire mutatja, mennyibe kerül ugyanaz
            az eladható változat a többi webshopban. A kiinduló webshop csak nézőpont —
            a párosításokat és a pontszámokat nem befolyásolja.</>
          : <>Minden sor egy pontosan meghatározott, eladható termékváltozat: évjárat,
            kiszerelés, darabszám és csomagolás szerint. Csak igazolt, friss ajánlat kerül
            a rangsorba.</>}
        actions={
          <>
            <Link className="btn btn-sm" href={`/api/v1/reports/export?format=xlsx&scope=comparison${anchorShopId ? `&anchorShopId=${anchorShopId}` : ''}`}>
              XLSX export
            </Link>
            <Link className="btn btn-sm" href="/parositas">Ellenőrzési sor</Link>
          </>
        }
      />

      {/* ── Összefoglaló számoszlop ─────────────────────────────────────── */}
      {summary.anchor ? (
        <AnchorTally anchor={summary.anchor} shopName={anchorShop?.name ?? 'A webshop'} />
      ) : (
        <GeneralTally g={g} />
      )}

      {/* ── Publikáció állapota ─────────────────────────────────────────── */}
      <PublicationBanner publication={summary.publication} shops={summary.shops} />

      {/* ── Szűrők ──────────────────────────────────────────────────────── */}
      <MatrixFilters
        categories={categories.items}
        shops={matrix.shopColumns}
        total={matrix.total}
      />

      {/* ── A mátrix ────────────────────────────────────────────────────── */}
      {matrix.items.length === 0 ? (
        <div className="empty">
          <div className="display">Még nincs publikált összehasonlítás</div>
          <p style={{ fontSize: 13, maxWidth: '56ch', margin: '0 auto' }}>
            Az összehasonlító mátrix akkor telik meg, ha legalább egy webshop katalógusa
            betöltődött, és a párosítások igazolttá váltak. Indíts egy felderítést a
            <Link href="/webshopok"> Webshopok</Link> oldalon, vagy tölts fel terméklistát az
            <Link href="/import"> Import</Link> alatt.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th className="sticky-col">Kanonikus termékváltozat</th>
                <th style={{ minWidth: 168 }}>Piaci szóródás</th>
                {anchorShop && (
                  <th className="shopcol anchor-col">
                    <span className="row-tight" style={{ justifyContent: 'flex-end', gap: 5 }}>
                      <ShopDot color={anchorShop.brand_color} />
                      {anchorShop.name}
                    </span>
                  </th>
                )}
                <th className="right" style={{ minWidth: 92 }}>Legolcsóbb</th>
                <th className="right" style={{ minWidth: 92 }}>Medián</th>
                {columns.filter((c) => c.id !== anchorShopId).map((shop) => (
                  <th key={shop.id} className="shopcol">
                    <span className="row-tight" style={{ justifyContent: 'flex-end', gap: 5 }}>
                      <ShopDot color={shop.brand_color} name={shop.name} />
                      {shop.name}
                    </span>
                  </th>
                ))}
                <th className="right">Boltok</th>
                <th>Adatminőség</th>
              </tr>
            </thead>
            <tbody>
              {matrix.items.map((row) => {
                const cells = row.cells ?? {};
                const railOffers = Object.entries(cells).map(([key, cell]) => {
                  const shop = matrix.shopColumns.find((s) => s.key === key);
                  return {
                    shopId: cell.shopId, shopKey: key,
                    shopName: shop?.name ?? key,
                    shopColor: shop?.brand_color ?? null,
                    priceHuf: cell.priceHuf, rank: cell.rank,
                    stale: cell.stale, onSale: cell.onSale,
                  };
                });

                return (
                  <tr key={row.canonical_variant_id}>
                    <td className="sticky-col">
                      <Link href={`/termek/${row.canonical_variant_id}`}
                            style={{ fontWeight: 500, color: 'var(--ink)' }}>
                        {row.canonical_display_name}
                      </Link>
                      <div className="cell-note">
                        {[
                          row.category_name,
                          row.producer_name ?? row.brand_name,
                          row.vintage_value ?? (row.vintage_status === 'non_vintage' ? 'NV' : null),
                          row.age_statement_years ? `${row.age_statement_years} éves` : null,
                          volume(row.volume_ml, row.pack_count),
                          row.packaging_type === 'gift_box' ? 'díszdoboz'
                            : row.packaging_type === 'wooden_case' ? 'fadoboz' : null,
                        ].filter(Boolean).join(' · ')}
                        {row.tracked && <span className="chip chip-wine" data-glyph="★" style={{ marginLeft: 6 }}>figyelt</span>}
                      </div>
                    </td>

                    <td>
                      <SpreadRail
                        offers={railOffers}
                        min={row.min_price_huf}
                        max={row.max_price_huf}
                        median={row.median_price_huf}
                        anchorShopId={anchorShopId || null}
                      />
                      {row.spread_pct !== null && row.spread_pct > 0 && (
                        <div className="cell-note num">
                          szóródás {huf(row.spread_huf)} · {pct(row.spread_pct)}
                        </div>
                      )}
                    </td>

                    {anchorShop && (
                      <td className="right anchor-col">
                        {row.anchor ? (
                          <>
                            <PriceCell
                              value={row.anchor.price_huf}
                              rank={row.anchor.rank_in_market}
                              denominator={row.anchor.rank_denominator}
                              stale={row.anchor.stale}
                              onSale={row.anchor.on_sale}
                              href={row.anchor.product_url}
                            />
                            {row.anchor.rank_in_market === 1 ? (
                              <span className="chip chip-verified" data-glyph="✓" style={{ marginTop: 3 }}>
                                legolcsóbb
                              </span>
                            ) : (
                              <div style={{ marginTop: 2 }}>
                                <DeltaBadge value={row.anchor.delta_to_min_pct} />
                                <div className="cell-note num">
                                  {row.anchor.delta_to_min_huf !== null && row.anchor.delta_to_min_huf > 0
                                    ? `+${hufShort(row.anchor.delta_to_min_huf)} Ft a minimumhoz`
                                    : ''}
                                </div>
                              </div>
                            )}
                          </>
                        ) : <span className="price price-none">—</span>}
                      </td>
                    )}

                    <td className="right">
                      <span className="price price-lead">{huf(row.min_price_huf)}</span>
                    </td>
                    <td className="right">
                      <span className="price">{huf(row.median_price_huf)}</span>
                    </td>

                    {columns.filter((c) => c.id !== anchorShopId).map((shop) => {
                      const cell = cells[shop.key];
                      return (
                        <td key={shop.id} className="right">
                          {cell ? (
                            <PriceCell
                              value={cell.priceHuf}
                              rank={cell.rank}
                              denominator={cell.denominator}
                              stale={cell.stale}
                              onSale={cell.onSale}
                              regular={cell.regularPriceHuf}
                              observedAt={cell.observedAt}
                              href={cell.url}
                              note={
                                cell.inStock === false ? 'nincs készleten'
                                  : cell.shopHealth !== 'ok' ? 'a forrás állapota nem rendben'
                                    : anchorShop && row.anchor
                                      ? `${cell.priceHuf > row.anchor.price_huf ? '+' : ''}${hufShort(cell.priceHuf - row.anchor.price_huf)} Ft`
                                      : null
                              }
                            />
                          ) : (
                            <span className="price price-none" title="Ebben a webshopban nincs igazolt, friss ajánlat erre a változatra.">—</span>
                          )}
                        </td>
                      );
                    })}

                    <td className="right num">{row.shop_count ?? 0}</td>
                    <td><DataQualityChip quality={row.data_quality} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={matrix.page} pageSize={matrix.pageSize} total={matrix.total}
                  hasMore={matrix.hasMore} params={sp} />
    </>
  );
}

// ── Összefoglalók ───────────────────────────────────────────────────────────

function GeneralTally({ g }: { g: Record<string, number> }) {
  const cells: Array<{ label: string; value: number; sub?: string; tone?: 'alert' | 'good' }> = [
    { label: 'Kanonikus változat', value: g['variants_active'] ?? 0, sub: `+${g['variants_proposed'] ?? 0} javasolt` },
    { label: 'Legalább 2 bolt', value: g['variants_multi_shop'] ?? 0, sub: 'valódi összehasonlítás', tone: 'good' },
    { label: 'Csak 1 boltban', value: g['variants_single_shop'] ?? 0, sub: 'nincs viszonyítás' },
    { label: 'Klaszterezetlen listing', value: g['listings_unclustered'] ?? 0, sub: `${g['listings_total'] ?? 0} listingből` },
    { label: 'Ellenőrzés kell', value: g['reviews_open'] ?? 0, sub: `ebből ${g['reviews_drift'] ?? 0} eltolódás`, tone: (g['reviews_open'] ?? 0) > 0 ? 'alert' : undefined },
    { label: 'Forráshiba', value: g['shops_unhealthy'] ?? 0, sub: 'nem egészséges webshop', tone: (g['shops_unhealthy'] ?? 0) > 0 ? 'alert' : undefined },
    { label: 'Árváltozás · 7 nap', value: g['price_changes_7d'] ?? 0, sub: 'jelentős vagy extrém' },
    { label: 'Figyelt termék', value: g['tracked_products'] ?? 0, sub: 'kiemelt figyelőlista' },
  ];
  return (
    <div className="tally rise" style={{ marginBottom: 20 }}>
      {cells.map((c) => (
        <div className="tally-cell" key={c.label}>
          <div className="label">{c.label}</div>
          <div className={`figure ${c.tone ?? ''}`}>{num(c.value)}</div>
          {c.sub && <div className="sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function AnchorTally({ anchor, shopName }: { anchor: Record<string, number>; shopName: string }) {
  const cells: Array<{ label: string; value: string; sub?: string; tone?: 'alert' | 'good' }> = [
    { label: 'Aktív listing', value: num(anchor['listings_active'] ?? 0), sub: `${shopName} kínálata` },
    { label: 'Összehasonlítható', value: num(anchor['comparable_products'] ?? 0), sub: 'igazolt kanonikus párral' },
    { label: 'Más boltban is', value: num(anchor['with_other_shop_offer'] ?? 0), sub: 'legalább egy másik ajánlat' },
    { label: 'Itt a legolcsóbb', value: num(anchor['cheapest_count'] ?? 0), sub: '1. hely a piacon', tone: 'good' },
    { label: 'Drágább a minimumnál', value: num(anchor['not_cheapest_count'] ?? 0), sub: 'van olcsóbb ajánlat', tone: (anchor['not_cheapest_count'] ?? 0) > 0 ? 'alert' : undefined },
    { label: 'Medián eltérés', value: pct(anchor['median_delta_to_min_pct'] ?? null), sub: 'a piaci minimumhoz' },
    { label: 'Nincs pár', value: num(anchor['not_found_count'] ?? 0), sub: 'teljes keresés után' },
    { label: 'Ellenőrzés kell', value: num(anchor['open_reviews'] ?? 0), sub: `+${anchor['unclustered'] ?? 0} klaszterezetlen`, tone: (anchor['open_reviews'] ?? 0) > 0 ? 'alert' : undefined },
  ];
  return (
    <div className="tally rise" style={{ marginBottom: 20 }}>
      {cells.map((c) => (
        <div className="tally-cell" key={c.label}>
          <div className="label">{c.label}</div>
          <div className={`figure ${c.tone ?? ''}`}>{c.value}</div>
          {c.sub && <div className="sub">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function PublicationBanner({
  publication, shops,
}: { publication: Record<string, unknown> | null; shops: Array<Record<string, unknown>> }) {
  const unhealthy = shops.filter((s) => {
    const h = String(s['health_status'] ?? '');
    return s['active'] && (h === 'failing' || h === 'blocked' || h === 'degraded');
  });

  if (!publication) {
    return (
      <div className="callout callout-alert" style={{ marginBottom: 20 }}>
        <strong>Nincs publikált piaci pillanatkép.</strong> Az összehasonlítás addig üres,
        amíg egy futás át nem megy a minőségi kapun. A korábbi jó adat sosem íródik felül
        hibás futással.
      </div>
    );
  }

  const staleShops = (publication['shops_stale'] as string[] | undefined) ?? [];

  return (
    <div className="row" style={{ marginBottom: 20, gap: 16 }}>
      <div className="callout callout-good" style={{ flex: 1, minWidth: 300 }}>
        <div className="row-tight" style={{ gap: 10 }}>
          <span className="chip chip-verified" data-glyph="✓">publikálva</span>
          <span className="num" style={{ fontSize: 12 }}>
            {num(Number(publication['variants_total'] ?? 0))} termékváltozat ·{' '}
            {num(Number(publication['offers_total'] ?? 0))} ajánlat ·{' '}
            {num(Number(publication['shops_included'] ?? 0))} webshop
          </span>
          <span className="freshness">{ago(String(publication['published_at'] ?? ''))}</span>
        </div>
      </div>

      {(unhealthy.length > 0 || staleShops.length > 0) && (
        <div className="callout callout-alert" style={{ flex: 1, minWidth: 300 }}>
          <div className="row-tight" style={{ gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 12 }}>Nem minden forrás friss:</strong>
            {unhealthy.slice(0, 4).map((s) => (
              <span key={String(s['id'])} className="row-tight" style={{ gap: 4 }}>
                <ShopDot color={String(s['brand_color'] ?? '')} />
                <span style={{ fontSize: 12 }}>{String(s['name'])}</span>
                <HealthChip status={String(s['health_status'])} />
              </span>
            ))}
            {staleShops.length > 0 && (
              <span className="freshness">{staleShops.length} forrás adata elavult jelöléssel szerepel</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Pagination({
  page, pageSize, total, hasMore, params,
}: {
  page: number; pageSize: number; total: number; hasMore: boolean;
  params: Record<string, string | string[] | undefined>;
}) {
  if (total <= pageSize) return null;
  const build = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v) qs.set(k, v);
    qs.set('page', String(p));
    return `?${qs.toString()}`;
  };
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="pagination">
      <span className="muted num">{from}–{to} / {num(total)}</span>
      <div className="spacer" />
      {page > 1 && <Link className="btn btn-sm" href={build(page - 1)}>← Előző</Link>}
      {hasMore && <Link className="btn btn-sm" href={build(page + 1)}>Következő →</Link>}
    </div>
  );
}
