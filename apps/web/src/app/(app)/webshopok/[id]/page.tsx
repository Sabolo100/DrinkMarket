import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHead } from '@/components/Shell';
import { HealthChip, ShopDot } from '@/components/Signals';
import { ShopActions } from '@/components/Actions';
import { api, apiSafe, ago, dateTime, huf, num, pct, requireSession } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function ShopDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();

  let data;
  try {
    data = await api<{
      shop: Record<string, unknown>;
      config: Record<string, unknown> | null;
      recentRuns: Array<Record<string, unknown>>;
      pendingJobs?: Array<Record<string, unknown>>;
    }>(`/shops/${id}`);
  } catch {
    notFound();
  }

  const comparison = await apiSafe<{
    shop: Record<string, unknown> | null;
    rankDistribution: Array<{ rank: number; count: number }>;
    mostExpensiveVsMarket: Array<Record<string, unknown>>;
  }>(`/dashboard/shop-comparison?anchorShopId=${id}`,
    { shop: null, rankDistribution: [], mostExpensiveVsMarket: [] });

  const s = data.shop;
  const c = data.config ?? {};
  const canManage = ['source_manager', 'admin'].includes(session.user.role);
  const totalRanked = comparison.rankDistribution.reduce((a, b) => a + b.count, 0);

  return (
    <>
      <PageHead
        title={String(s['name'])}
        lede={
          <span className="row-tight" style={{ gap: 8 }}>
            <ShopDot color={s['brand_color'] as string} />
            <a href={String(s['base_url'])} target="_blank" rel="noopener noreferrer nofollow">
              {String(s['base_url']).replace(/^https?:\/\//, '')}
            </a>
            <HealthChip status={String(s['health_status'])} />
            {s['policy_disabled'] ? (
              <span className="chip chip-rejected" data-glyph="⊘">policy-tiltás</span>
            ) : null}
          </span>
        }
        actions={
          <>
            <Link className="btn btn-sm" href={`/termektar?shopId=${id}`}>Terméktár</Link>
            <Link className="btn btn-sm" href={`/?anchorShopId=${id}`}>Kiinduló webshopként</Link>
            {canManage && <ShopActions shopId={id} csrfToken={session.csrfToken}
                                        disabled={Boolean(s['policy_disabled'])} />}
          </>
        }
      />

      {s['policy_disabled'] ? (
        <div className="callout callout-alert" style={{ marginBottom: 18 }}>
          <strong>A forrás jogi vagy policy okból le van tiltva.</strong>{' '}
          {String(c['policy_disabled_reason'] ?? 'Nincs megadva indok.')} A rendszer nem
          crawlolja, és a hiányzó adat NEM jelenik meg „nincs ilyen termék” eredményként.
        </div>
      ) : null}

      <div className="tally" style={{ marginBottom: 20 }}>
        <Cell label="Aktív listing" value={num(Number(s['listings_active'] ?? 0))} />
        <Cell label="Klaszterezve" value={num(Number(s['listings_clustered'] ?? 0))}
              sub={`${num(Number(s['listings_unclustered'] ?? 0))} még nem`} />
        <Cell label="Igazolt pár" value={num(Number(s['verified_matches'] ?? 0))} tone="good" />
        <Cell label="Ellenőrzés kell" value={num(Number(s['open_reviews'] ?? 0))}
              tone={Number(s['open_reviews'] ?? 0) > 0 ? 'alert' : undefined} />
        <Cell label="Itt a legolcsóbb"
              value={num(comparison.rankDistribution.find((r) => r.rank === 1)?.count ?? 0)}
              sub={totalRanked ? `${totalRanked} összevethető termékből` : undefined} tone="good" />
        <Cell label="Utolsó felderítés" value={ago(s['last_successful_discovery_at'] as string)} />
      </div>

      <div className="row" style={{ alignItems: 'stretch', gap: 16, marginBottom: 20 }}>
        {/* Konfiguráció */}
        <div className="sheet sheet-pad" style={{ flex: '1 1 340px' }}>
          <div className="label" style={{ marginBottom: 10 }}>Forrásprofil és crawl policy</div>
          <dl className="kv">
            <dt>Adapter</dt>
            <dd className="num">{String(s['adapter_key'])} v{String(s['adapter_version'])}</dd>
            <dt>Felderítési út</dt><dd>{strategyLabel(String(c['discovery_strategy'] ?? ''))}</dd>
            <dt>Sebesség</dt>
            <dd className="num">
              {String(c['requests_per_second'] ?? '—')} kérés/mp · {String(c['max_concurrency'] ?? '—')} párhuzamos
            </dd>
            <dt>Időkorlát</dt><dd className="num">{String(c['request_timeout_ms'] ?? '—')} ms</dd>
            <dt>Újrapróbálás</dt><dd className="num">{String(c['max_retries'] ?? '—')}×</dd>
            <dt>robots.txt</dt>
            <dd>
              {c['respect_robots'] ? 'figyelembe vesszük' : 'figyelmen kívül (külön engedéllyel)'}
              {c['robots_allows_crawl'] === false && (
                <span className="chip chip-rejected" data-glyph="⊘" style={{ marginLeft: 6 }}>tiltja</span>
              )}
              <div className="cell-note">ellenőrizve: {ago(c['robots_last_checked_at'] as string)}</div>
            </dd>
            <dt>Böngésző</dt>
            <dd>{c['allow_browser'] ? 'engedélyezett (csak végső esetben)' : 'nem engedélyezett'}</dd>
            <dt>Felderítés</dt>
            <dd className="num">{String(c['discovery_interval_hours'] ?? '—')} óránként</dd>
            <dt>Árfrissítés</dt>
            <dd className="num">{String(c['price_refresh_interval_hours'] ?? '—')} óránként</dd>
            <dt>Elvárt katalógus</dt>
            <dd className="num">
              {c['expected_catalog_min'] ? `${num(Number(c['expected_catalog_min']))} – ` : ''}
              {c['expected_catalog_max'] ? num(Number(c['expected_catalog_max'])) : 'nincs megadva'}
            </dd>
            <dt>Jogi státusz</dt>
            <dd>
              {String(c['legal_review_status'] ?? 'pending')}
              {c['terms_review_note'] ? (
                <div className="cell-note">{String(c['terms_review_note'])}</div>
              ) : null}
            </dd>
          </dl>
        </div>

        {/* Piaci pozíció eloszlás */}
        <div className="sheet sheet-pad" style={{ flex: '1 1 340px' }}>
          <div className="label" style={{ marginBottom: 10 }}>Ár-pozíció eloszlás a piacon</div>
          {comparison.rankDistribution.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              Még nincs elég összevethető termék. Az eloszlás akkor jelenik meg, ha
              legalább egy termékre két webshop ajánlata is igazolt.
            </p>
          ) : (
            <div className="stack-2">
              {comparison.rankDistribution.map((r) => {
                const share = totalRanked ? (r.count / totalRanked) * 100 : 0;
                return (
                  <div key={r.rank}>
                    <div className="row-tight" style={{ justifyContent: 'space-between', fontSize: 12 }}>
                      <span>{r.rank}. legolcsóbb{r.rank === 1 ? ' (piacvezető ár)' : ''}</span>
                      <span className="num">{r.count} · {pct(share)}</span>
                    </div>
                    <div style={{ height: 6, background: 'var(--paper-3)', borderRadius: 1, marginTop: 3,
                                  border: '1px solid var(--rule-faint)' }}>
                      <div style={{
                        width: `${share}%`, height: '100%',
                        background: r.rank === 1 ? 'var(--verdigris)' : 'var(--cork)',
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Legnagyobb elmaradás a piaci minimumtól */}
      {comparison.mostExpensiveVsMarket.length > 0 && (
        <section style={{ marginBottom: 20 }}>
          <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>
            Legnagyobb eltérés a piaci minimumtól
          </h2>
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th className="sticky-col">Termékváltozat</th>
                  <th className="right">Ár itt</th>
                  <th className="right">Rang</th>
                  <th className="right">Eltérés</th>
                  <th>Legolcsóbb máshol</th>
                </tr>
              </thead>
              <tbody>
                {comparison.mostExpensiveVsMarket.map((r) => {
                  const cheapest = r['cheapest'] as { shopName: string; priceHuf: number; url: string } | null;
                  return (
                    <tr key={String(r['canonical_variant_id'])}>
                      <td className="sticky-col">
                        <Link href={`/termek/${r['canonical_variant_id']}`} style={{ color: 'var(--ink)' }}>
                          {String(r['canonical_display_name'])}
                        </Link>
                      </td>
                      <td className="right"><span className="price price-high">{huf(Number(r['price_huf']))}</span></td>
                      <td className="right num">{String(r['rank_in_market'])}/{String(r['rank_denominator'])}</td>
                      <td className="right num" style={{ color: 'var(--rust)' }}>
                        +{huf(Number(r['delta_to_min_huf']))}
                        <div className="cell-note">{pct(Number(r['delta_to_min_pct']))}</div>
                      </td>
                      <td>
                        {cheapest ? (
                          <a href={cheapest.url} target="_blank" rel="noopener noreferrer nofollow">
                            {cheapest.shopName} — {huf(cheapest.priceHuf)} ↗
                          </a>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Futások */}
      <section>
        <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>Legutóbbi futások</h2>
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Indulás</th>
                <th>Típus</th>
                <th>Állapot</th>
                <th>Forrás</th>
                <th className="right">Új</th>
                <th className="right">Módosult</th>
                <th className="right">Eltűnt</th>
                <th className="right">Kinyerés ok/hiba</th>
                <th className="right">Katalógus</th>
                <th>Teljesség</th>
                <th>Minőségi kapu</th>
                <th className="right">Időtartam</th>
              </tr>
            </thead>
            <tbody>
              {/* Beküldött, de még el nem indult feladatok. A crawl_runs sort a
                  feldolgozó hozza létre, amikor ténylegesen hozzákezd - a
                  várakozó feladat addig sehol nem látszott. */}
              {(data.pendingJobs ?? []).map((j) => (
                <tr key={`pending-${String(j['id'])}`} style={{ opacity: 0.75 }}>
                  <td className="freshness">{dateTime(j['created_at'] as string)}</td>
                  <td style={{ fontSize: 12 }}>{runTypeLabel(jobNameToRunType(String(j['job_name'])))}</td>
                  <td>
                    <span className="chip chip-neutral" title="A feladat sorban áll; a felderítést egyszerre két futás dolgozza fel.">
                      várakozik
                    </span>
                  </td>
                  <td colSpan={9} className="muted" style={{ fontSize: 11 }}>
                    beküldve, még nem indult el
                  </td>
                </tr>
              ))}
              {data.recentRuns.length === 0 && (data.pendingJobs ?? []).length === 0 ? (
                <tr><td colSpan={12} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  Még nem futott le semmi ezen a forráson.
                </td></tr>
              ) : data.recentRuns.map((r) => (
                <tr key={String(r['id'])}>
                  <td className="freshness">{dateTime(r['started_at'] as string)}</td>
                  <td style={{ fontSize: 12 }}>{runTypeLabel(String(r['run_type']))}</td>
                  <td><RunStatusChip status={String(r['status'])} /></td>
                  <td style={{ fontSize: 11 }} className="muted">{String(r['source_status'] ?? '—')}</td>
                  <td className="right num">{String(r['listings_new'] ?? 0)}</td>
                  <td className="right num">{String(r['listings_updated'] ?? 0)}</td>
                  <td className="right num">{String(r['listings_missing'] ?? 0)}</td>
                  <td className="right num">
                    {String(r['extract_ok'] ?? 0)} / <span style={{ color: Number(r['extract_failed']) > 0 ? 'var(--rust)' : undefined }}>
                      {String(r['extract_failed'] ?? 0)}
                    </span>
                  </td>
                  <td className="right num">{r['catalog_size_after'] ? num(Number(r['catalog_size_after'])) : '—'}</td>
                  <td style={{ fontSize: 11 }}>
                    {r['completeness'] === 'complete' ? 'teljes'
                      : r['completeness'] === 'partial' ? 'részleges' : 'ismeretlen'}
                  </td>
                  <td>
                    {r['quality_gate_passed'] === true
                      ? <span className="chip chip-verified" data-glyph="✓">átment</span>
                      : r['quality_gate_passed'] === false
                        ? <span className="chip chip-rejected" data-glyph="×" title={String(r['quarantine_reason'] ?? '')}>
                            megbukott
                          </span>
                        : <span className="chip chip-neutral" data-glyph="·">—</span>}
                  </td>
                  <td className="right num">
                    {r['duration_ms'] ? `${Math.round(Number(r['duration_ms']) / 1000)} mp` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Cell({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'good' | 'alert';
}) {
  return (
    <div className="tally-cell">
      <div className="label">{label}</div>
      <div className={`figure ${tone ?? ''}`} style={{ fontSize: 22 }}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function RunStatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: string; glyph: string }> = {
    succeeded:   { label: 'sikeres', tone: 'chip-verified', glyph: '✓' },
    partial:     { label: 'részleges', tone: 'chip-review', glyph: '~' },
    failed:      { label: 'hibás', tone: 'chip-rejected', glyph: '×' },
    quarantined: { label: 'karantén', tone: 'chip-rejected', glyph: '⊘' },
    running:     { label: 'fut', tone: 'chip-neutral', glyph: '◌' },
    cancelled:   { label: 'megszakítva', tone: 'chip-neutral', glyph: '‖' },
  };
  const s = map[status] ?? { label: status, tone: 'chip-neutral', glyph: '·' };
  return <span className={`chip ${s.tone}`} data-glyph={s.glyph}>{s.label}</span>;
}

/** A sorban allo job neve a futastipus-cimkere kepezve. */
function jobNameToRunType(jobName: string): string {
  const map: Record<string, string> = {
    discovery: 'discovery',
    'health-check': 'health_check',
    'refresh-shop': 'price_refresh',
    research: 'targeted_search',
  };
  return map[jobName] ?? jobName;
}

function runTypeLabel(type: string): string {
  const map: Record<string, string> = {
    discovery: 'katalógus-felderítés', price_refresh: 'árfrissítés',
    health_check: 'health check', targeted_search: 'célzott keresés',
    single_url: 'egyedi URL', adapter_test: 'adaptertesz',
  };
  return map[type] ?? type;
}

function strategyLabel(strategy: string): string {
  const map: Record<string, string> = {
    feed: 'termékfeed', platform_api: 'platform API', sitemap: 'XML sitemap',
    category_pages: 'kategóriaoldalak', search_only: 'csak belső kereső',
    manual: 'kézi', browser: 'böngészős renderelés',
  };
  return map[strategy] ?? strategy;
}
