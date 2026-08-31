import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHead } from '@/components/Shell';
import { SpreadRailDetailed } from '@/components/SpreadRail';
import { PriceHistoryChart } from '@/components/PriceHistoryChart';
import {
  DataQualityChip, DeltaBadge, HealthChip, MatchStatusChip, PriceCell, Seal, ShopDot,
} from '@/components/Signals';
import { SearchNowButton } from '@/components/Actions';
import { api, apiSafe, ago, dateTime, huf, hufShort, num, pct, volume, requireSession } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function ProductPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const anchorShopId = typeof sp['anchorShopId'] === 'string' ? sp['anchorShopId'] : '';
  const session = await requireSession();

  let data;
  try {
    data = await api<{
      variant: Record<string, unknown>;
      offers: Array<Record<string, unknown>>;
      listings: Array<Record<string, unknown>>;
      shopStatus: Array<Record<string, unknown>>;
      recentEvents: Array<Record<string, unknown>>;
    }>(`/products/${id}`);
  } catch {
    notFound();
  }

  const history = await apiSafe<{ items: Array<Record<string, unknown>> }>(
    `/products/${id}/price-history?days=180`, { items: [] },
  );

  const v = data.variant;
  const offers = data.offers;
  const railOffers = offers.map((o) => ({
    shopId: String(o['shop_id']),
    shopName: String(o['shop_name']),
    shopColor: (o['shop_color'] as string | null) ?? null,
    priceHuf: Number(o['price_huf']),
    rank: o['rank_in_market'] as number | null,
    stale: Boolean(o['stale']),
    onSale: Boolean(o['on_sale']),
  }));

  const identityProfile = (v['identity_profile_json'] ?? v['category_identity_profile'] ?? {}) as {
    required?: string[]; contradiction_only?: string[]; not_applicable?: string[];
  };
  const evidence = (v['evidence'] ?? {}) as Record<string, { raw_value?: string; method?: string; source_location?: string; confidence?: number }>;

  return (
    <>
      <PageHead
        title={String(v['canonical_display_name'])}
        lede={
          <>
            {[v['category_name'], v['producer_name'] ?? v['brand_name'], v['region']]
              .filter(Boolean).join(' · ')}
            {' — '}
            <span className="muted">
              a rendszer ezt a pontos, eladható változatot hasonlítja össze; eltérő évjárat,
              kiszerelés vagy csomagolás külön terméknek számít.
            </span>
          </>
        }
        actions={
          <>
            <SearchNowButton productId={id} csrfToken={session.csrfToken} />
            <Link className="btn btn-sm" href={`/parositas?variantId=${id}`}>Párosítások</Link>
          </>
        }
      />

      {/* ── Identitáskártya ─────────────────────────────────────────────── */}
      <div className="row" style={{ alignItems: 'stretch', gap: 16, marginBottom: 20 }}>
        <div className="sheet sheet-pad" style={{ flex: '1 1 320px' }}>
          <div className="label" style={{ marginBottom: 10 }}>Kanonikus identitás</div>
          <dl className="kv">
            <IdentityRow label="Termelő / márka"
                         value={String(v['producer_name'] ?? v['brand_name'] ?? '—')}
                         field="producer" profile={identityProfile} evidence={evidence} />
            <IdentityRow label="Tétel / expression"
                         value={String(v['product_line'] ?? v['family_name'] ?? '—')}
                         field="expression" profile={identityProfile} evidence={evidence} />
            <IdentityRow label="Évjárat"
                         value={v['vintage_value'] ? String(v['vintage_value'])
                           : v['vintage_status'] === 'non_vintage' ? 'évjárat nélküli (NV)'
                             : v['vintage_status'] === 'not_applicable' ? 'nem értelmezett'
                               : 'nem bizonyított'}
                         field="vintage" profile={identityProfile} evidence={evidence}
                         warn={v['vintage_status'] === 'unknown'} />
            {v['age_statement_years'] ? (
              <IdentityRow label="Korjelölés" value={`${v['age_statement_years']} éves`}
                           field="age_statement_years" profile={identityProfile} evidence={evidence} />
            ) : null}
            <IdentityRow label="Kiszerelés"
                         value={volume(v['volume_ml'] as number | null, Number(v['pack_count'] ?? 1))}
                         field="volume_ml" profile={identityProfile} evidence={evidence}
                         warn={!v['volume_ml']} />
            <IdentityRow label="Csomagolás" value={packagingLabel(String(v['packaging_type']))}
                         field="packaging_type" profile={identityProfile} evidence={evidence} />
            {v['edition'] ? (
              <IdentityRow label="Kiadás" value={String(v['edition'])}
                           field="edition" profile={identityProfile} evidence={evidence} />
            ) : null}
            {v['abv_percent'] ? (
              <IdentityRow label="Alkohol" value={`${v['abv_percent']}%`}
                           field="abv_percent" profile={identityProfile} evidence={evidence} />
            ) : null}
            {v['gtin'] ? (
              <IdentityRow label="EAN / GTIN" value={String(v['gtin'])}
                           field="gtin" profile={identityProfile} evidence={evidence} />
            ) : null}
            <dt>Állapot</dt>
            <dd>
              <span className={`chip ${v['variant_status'] === 'active' ? 'chip-verified' : 'chip-review'}`}
                    data-glyph={v['variant_status'] === 'active' ? '✓' : '·'}>
                {v['variant_status'] === 'active' ? 'jóváhagyott' : String(v['variant_status'])}
              </span>
              <span className="freshness" style={{ marginLeft: 8 }}>
                forrás: {originLabel(String(v['origin']))} · v{String(v['version'] ?? 1)}
              </span>
            </dd>
          </dl>

          {identityProfile.required?.length ? (
            <div className="callout" style={{ marginTop: 14, fontSize: 12 }}>
              <strong>Kötelező azonossági mezők ennél a kategóriánál:</strong>{' '}
              {identityProfile.required.map(fieldLabel).join(', ')}. Ezek bármelyikének
              hiánya vagy eltérése megakadályozza az automatikus párosítást.
            </div>
          ) : null}
        </div>

        {/* ── Piaci pozíció ────────────────────────────────────────────── */}
        <div className="sheet sheet-pad" style={{ flex: '2 1 460px' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
            <div className="label">Piaci szóródás</div>
            <div className="row-tight">
              <DataQualityChip quality={String(v['data_quality'] ?? 'degraded')} />
              {v['any_on_sale'] ? <span className="chip chip-sale" data-glyph="%">akció</span> : null}
            </div>
          </div>

          <SpreadRailDetailed
            offers={railOffers}
            median={v['median_price_huf'] as number | null}
            anchorShopId={anchorShopId || null}
          />

          <div className="tally" style={{ marginTop: 8, border: 'none' }}>
            <div className="tally-cell" style={{ borderLeft: 'none' }}>
              <div className="label">Legolcsóbb</div>
              <div className="figure good" style={{ fontSize: 20 }}>{huf(v['min_price_huf'] as number)}</div>
            </div>
            <div className="tally-cell">
              <div className="label">Medián</div>
              <div className="figure" style={{ fontSize: 20 }}>{huf(v['median_price_huf'] as number)}</div>
            </div>
            <div className="tally-cell">
              <div className="label">Legdrágább</div>
              <div className="figure alert" style={{ fontSize: 20 }}>{huf(v['max_price_huf'] as number)}</div>
            </div>
            <div className="tally-cell" style={{ borderRight: 'none' }}>
              <div className="label">Szóródás</div>
              <div className="figure" style={{ fontSize: 20 }}>{pct(v['spread_pct'] as number)}</div>
              <div className="sub">{huf(v['spread_huf'] as number)} különbség</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Ajánlatok webshoponként ─────────────────────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 className="display" style={{ fontSize: 19 }}>Igazolt ajánlatok</h2>
          <span className="label">{offers.length} webshop</span>
        </div>
        {offers.length === 0 ? (
          <div className="empty">
            <div className="display">Még nincs igazolt ajánlat</div>
            <p style={{ fontSize: 13 }}>
              A rendszer keresi ezt a változatot a webshopokban. A keresés állapotát
              lentebb, webshoponként látod.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Webshop</th>
                  <th>A webshop terméknevé</th>
                  <th className="right">Ár</th>
                  <th className="right">Rang</th>
                  <th className="right">Eltérés a minimumtól</th>
                  <th className="right">Eltérés a mediántól</th>
                  <th>Készlet</th>
                  <th>Párosítás</th>
                  <th>Frissesség</th>
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => (
                  <tr key={String(o['shop_id'])}
                      className={o['shop_id'] === anchorShopId ? 'anchor-col' : undefined}>
                    <td>
                      <span className="row-tight" style={{ gap: 6 }}>
                        <ShopDot color={o['shop_color'] as string} />
                        <Link href={`/webshopok/${o['shop_id']}`}>{String(o['shop_name'])}</Link>
                      </span>
                    </td>
                    <td>
                      <a href={String(o['product_url'])} target="_blank" rel="noopener noreferrer nofollow"
                         style={{ color: 'var(--ink-2)' }}>
                        {String(o['listing_name'])} ↗
                      </a>
                    </td>
                    <td className="right">
                      <PriceCell value={Number(o['price_huf'])}
                                 onSale={Boolean(o['on_sale'])}
                                 regular={o['regular_price_huf'] as number | null}
                                 stale={Boolean(o['stale'])} />
                    </td>
                    <td className="right num">
                      {o['rank_in_market'] ? `${o['rank_in_market']}/${o['rank_denominator']}` : '—'}
                      {o['tied'] ? <span className="freshness"> holtverseny</span> : null}
                    </td>
                    <td className="right"><DeltaBadge value={o['delta_to_min_pct'] as number} /></td>
                    <td className="right"><DeltaBadge value={o['delta_to_median_pct'] as number} /></td>
                    <td>
                      {o['in_stock'] === true ? <span className="chip chip-verified" data-glyph="✓">készleten</span>
                        : o['in_stock'] === false ? <span className="chip chip-neutral" data-glyph="⌀">elfogyott</span>
                          : <span className="chip chip-neutral" data-glyph="?">ismeretlen</span>}
                    </td>
                    <td><MatchStatusChip status={String(o['match_status'] === 'verified'
                      ? (o['decision_origin'] === 'human' ? 'human_verified' : 'auto_verified')
                      : String(o['match_status']))} /></td>
                    <td>
                      <span className="freshness" data-stale={o['stale'] ? 'true' : undefined}>
                        {ago(String(o['observed_at']))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Ártörténet ──────────────────────────────────────────────────── */}
      {history.items.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 className="display" style={{ fontSize: 19 }}>Ártörténet</h2>
            <span className="label">utolsó 180 nap</span>
          </div>
          <div className="sheet sheet-pad">
            <PriceHistoryChart points={history.items} />
          </div>
        </section>
      )}

      {/* ── Keresési állapot webshoponként ──────────────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <h2 className="display" style={{ fontSize: 19, marginBottom: 8 }}>
          Keresési állapot webshoponként
        </h2>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10, maxWidth: '80ch' }}>
          A rendszer megkülönbözteti a „egészséges forrás mellett nincs ilyen termék” és a
          „technikai hiba miatt nem tudjuk” eseteket. Egyetlen keresési hiba sem
          eredményezhet „nincs ilyen termék” állapotot.
        </p>
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Webshop</th>
                <th>Állapot</th>
                <th>Forrás egészsége</th>
                <th className="right">Próbálkozás</th>
                <th>Utolsó keresés</th>
                <th>Utolsó teljes keresés</th>
                <th>Következő keresés</th>
                <th>Fő indok</th>
              </tr>
            </thead>
            <tbody>
              {data.shopStatus.map((s) => (
                <tr key={String(s['shop_id'])}>
                  <td>
                    <span className="row-tight" style={{ gap: 6 }}>
                      <ShopDot color={s['brand_color'] as string} />
                      {String(s['shop_name'])}
                    </span>
                  </td>
                  <td><MatchStatusChip status={String(s['status'])} /></td>
                  <td><HealthChip status={String(s['health_status'])} /></td>
                  <td className="right num">{String(s['search_attempt_count'] ?? 0)}</td>
                  <td className="freshness">{ago(s['last_search_at'] as string)}</td>
                  <td className="freshness">{ago(s['last_full_search_at'] as string)}</td>
                  <td className="freshness">
                    {s['next_search_at'] ? dateTime(s['next_search_at'] as string) : '—'}
                  </td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {(s['reason_codes'] as string[] | null)?.slice(0, 2).join(', ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Legutóbbi események ─────────────────────────────────────────── */}
      {data.recentEvents.length > 0 && (
        <section>
          <h2 className="display" style={{ fontSize: 19, marginBottom: 8 }}>Legutóbbi események</h2>
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Idő</th><th>Esemény</th><th>Webshop</th>
                  <th className="right">Előző</th><th className="right">Új</th>
                  <th className="right">Változás</th><th>Jelentőség</th>
                </tr>
              </thead>
              <tbody>
                {data.recentEvents.map((e) => (
                  <tr key={String(e['id'])}>
                    <td className="freshness">{dateTime(e['occurred_at'] as string)}</td>
                    <td>{eventLabel(String(e['event_type']))}</td>
                    <td>{String(e['shop_name'] ?? '—')}</td>
                    <td className="right num">{e['previous_price_huf'] ? hufShort(Number(e['previous_price_huf'])) : '—'}</td>
                    <td className="right num">{e['new_price_huf'] ? hufShort(Number(e['new_price_huf'])) : '—'}</td>
                    <td className="right"><DeltaBadge value={e['delta_pct'] as number} invert /></td>
                    <td>
                      {e['significance'] === 'extreme' ? <span className="chip chip-rejected" data-glyph="!">extrém</span>
                        : e['significance'] === 'significant' ? <span className="chip chip-review" data-glyph="~">jelentős</span>
                          : <span className="chip chip-neutral" data-glyph="·">normál</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// ── Segédek ─────────────────────────────────────────────────────────────────

function IdentityRow({
  label, value, field, profile, evidence, warn,
}: {
  label: string; value: string; field: string;
  profile: { required?: string[]; contradiction_only?: string[] };
  evidence: Record<string, { raw_value?: string; method?: string; source_location?: string }>;
  warn?: boolean;
}) {
  const isRequired = profile.required?.includes(field);
  const ev = evidence[field];
  return (
    <>
      <dt>
        {label}
        {isRequired && <span className="chip chip-neutral" data-glyph="!" style={{ marginLeft: 4, fontSize: 9, padding: '0 4px' }}>köt.</span>}
      </dt>
      <dd>
        <span style={{ color: warn ? 'var(--brass)' : undefined, fontWeight: warn ? 600 : 400 }}>
          {value}
        </span>
        {ev?.raw_value && (
          <div className="evidence-note" title={`Forrás: ${ev.source_location} (${ev.method})`}>
            „{ev.raw_value}” · {ev.method}
          </div>
        )}
      </dd>
    </>
  );
}

function packagingLabel(type: string): string {
  const map: Record<string, string> = {
    standard: 'normál palack', gift_box: 'díszdoboz', wooden_case: 'fadoboz',
    carton: 'karton', tube: 'tubus', set: 'szett', tin: 'fémdoboz', unknown: 'nem bizonyított',
  };
  return map[type] ?? type;
}

function originLabel(origin: string): string {
  const map: Record<string, string> = {
    manual: 'kézi felvitel', import: 'import', shop_catalog: 'webshop-katalógus',
    auto_discovery: 'automatikus felderítés', legacy_import: 'régi rendszer',
    review_split: 'review szétválasztás',
  };
  return map[origin] ?? origin;
}

function fieldLabel(field: string): string {
  const map: Record<string, string> = {
    producer: 'termelő', brand: 'márka', expression: 'tétel', vintage: 'évjárat',
    vintage_status: 'évjárat státusz', volume_ml: 'kiszerelés', pack_count: 'darabszám',
    packaging_type: 'csomagolás', age_statement_years: 'korjelölés',
    dosage_style: 'dosage', puttony: 'puttonyszám', edition: 'kiadás',
    cask_finish: 'hordóérlelés', abv_percent: 'alkoholtartalom', gtin: 'EAN',
  };
  return map[field] ?? field;
}

function eventLabel(type: string): string {
  const map: Record<string, string> = {
    first_seen: 'első észlelés', price_changed: 'árváltozás',
    availability_changed: 'készletváltozás', sale_started: 'akció indult',
    sale_ended: 'akció véget ért', listing_missing: 'listing eltűnt',
    listing_returned: 'listing visszatért', identity_drift: 'identitás-eltolódás',
    price_anomaly: 'áranomália',
  };
  return map[type] ?? type;
}
