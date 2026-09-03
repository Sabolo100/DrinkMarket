import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { HealthChip, ShopDot } from '@/components/Signals';
import { ShopActions, ShopActiveToggle } from '@/components/Actions';
import { apiSafe, ago, dateTime, num, requireSession } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Shop {
  id: string; key: string; name: string; base_url: string; segment: string;
  active: boolean; policy_disabled: boolean; adapter_key: string; adapter_version: string;
  health_status: string; health_checked_at: string | null; legal_review_status: string;
  brand_color: string | null;
  last_successful_discovery_at: string | null; last_price_refresh_at: string | null;
  next_discovery_at: string | null; next_price_refresh_at: string | null;
  expected_catalog_min: number | null; expected_catalog_max: number | null;
  listings_active: number; listings_clustered: number; listings_unclustered: number;
  verified_matches: number; open_reviews: number;
  last_run_id: string | null; last_run_status: string | null; last_run_at: string | null;
}

const LEGAL: Record<string, { label: string; tone: string; glyph: string }> = {
  pending:    { label: 'Jogi ellenőrzés függőben', tone: 'chip-review', glyph: '?' },
  approved:   { label: 'Jogilag jóváhagyva', tone: 'chip-verified', glyph: '✓' },
  restricted: { label: 'Korlátozott', tone: 'chip-review', glyph: '!' },
  blocked:    { label: 'Jogilag tiltva', tone: 'chip-rejected', glyph: '⊘' },
};

export default async function ShopsPage() {
  const session = await requireSession();
  const [health, queues] = await Promise.all([
    apiSafe<{
      shops: Shop[];
      latestRuns: Array<Record<string, unknown>>;
      alerts: Array<Record<string, unknown>>;
    }>('/dashboard/source-health', { shops: [], latestRuns: [], alerts: [] }),
    apiSafe<{ queues: Array<{ queue: string; waiting: number; active: number; delayed: number; failed: number }> }>(
      '/queues', { queues: [] }),
  ]);

  const canManage = ['source_manager', 'admin'].includes(session.user.role);
  const runByShop = new Map(health.latestRuns.map((r) => [String(r['shop_id']), r]));

  return (
    <>
      <PageHead
        title="Webshopok és futások"
        lede={
          <>Minden forrás saját adapterrel, saját sebességkorláttal és saját jogi
          státusszal fut. Egy forrás hibája nem állítja meg a többit, és a hibás futás
          nem írja felül az utolsó jó adatot.</>
        }
      />

      {/* Riasztások */}
      {health.alerts.length > 0 && (
        <div className="callout callout-alert" style={{ marginBottom: 18 }}>
          <strong>{health.alerts.length} nyitott riasztás</strong>
          <div className="stack-2" style={{ marginTop: 8 }}>
            {health.alerts.slice(0, 5).map((a) => (
              <div key={String(a['id'])} className="row-tight" style={{ gap: 8, fontSize: 12 }}>
                <span className={`chip ${a['level'] === 'critical' || a['level'] === 'error' ? 'chip-rejected' : 'chip-review'}`}
                      data-glyph="!">{String(a['level'])}</span>
                <strong>{String(a['title'])}</strong>
                <span className="muted">{String(a['message']).slice(0, 140)}</span>
                <div className="spacer" />
                <span className="freshness">
                  {ago(String(a['last_seen_at']))}
                  {Number(a['occurrence_count']) > 1 ? ` · ${a['occurrence_count']}×` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Webshop kártyák — közös lapon, hajszálvonallal osztva */}
      <div className="table-wrap" style={{ marginBottom: 20 }}>
        <table className="ledger">
          <thead>
            <tr>
              <th className="sticky-col">Webshop</th>
              <th>Állapot</th>
              <th>Jogi státusz</th>
              <th>Adapter</th>
              <th className="right">Aktív listing</th>
              <th className="right">Klaszterezett</th>
              <th className="right">Igazolt pár</th>
              <th className="right">Ellenőrzés</th>
              <th>Utolsó felderítés</th>
              <th>Utolsó árfrissítés</th>
              <th>Következő futás</th>
              {canManage && <th className="right">Műveletek</th>}
            </tr>
          </thead>
          <tbody>
            {health.shops.map((shop) => {
              const run = runByShop.get(shop.id);
              const legal = LEGAL[shop.legal_review_status] ?? LEGAL['pending']!;
              const clusterPct = shop.listings_active > 0
                ? Math.round((shop.listings_clustered / shop.listings_active) * 100) : 0;
              return (
                <tr key={shop.id} style={{ opacity: shop.active ? 1 : 0.55 }}>
                  <td className="sticky-col">
                    <span className="row-tight" style={{ gap: 7 }}>
                      <ShopDot color={shop.brand_color} />
                      <Link href={`/webshopok/${shop.id}`} style={{ fontWeight: 600, color: 'var(--ink)' }}>
                        {shop.name}
                      </Link>
                      {!shop.active && <span className="chip chip-neutral" data-glyph="‖">inaktív</span>}
                      {shop.policy_disabled && (
                        <span className="chip chip-rejected" data-glyph="⊘"
                              title="Jogi vagy policy okból a crawling le van tiltva.">policy-tiltás</span>
                      )}
                    </span>
                    <div className="cell-note">
                      {shop.base_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                      {' · '}{shop.segment === 'wine' ? 'bor' : shop.segment === 'spirit' ? 'tömény' : 'vegyes'}
                    </div>
                  </td>
                  <td>
                    <HealthChip status={shop.health_status} />
                    <div className="cell-note">{ago(shop.health_checked_at)}</div>
                  </td>
                  <td>
                    <span className={`chip ${legal.tone}`} data-glyph={legal.glyph}>{legal.label}</span>
                  </td>
                  <td>
                    <span className="num" style={{ fontSize: 11 }}>{shop.adapter_key}</span>
                    <div className="cell-note num">v{shop.adapter_version}</div>
                  </td>
                  <td className="right num">
                    {num(shop.listings_active)}
                    {shop.expected_catalog_min && (
                      <div className="cell-note">
                        elvárt min. {num(shop.expected_catalog_min)}
                      </div>
                    )}
                  </td>
                  <td className="right num">
                    {num(shop.listings_clustered)}
                    <div className="cell-note">{clusterPct}%</div>
                  </td>
                  <td className="right num">{num(shop.verified_matches)}</td>
                  <td className="right num">
                    {shop.open_reviews > 0 ? (
                      <Link href={`/parositas?shopId=${shop.id}`} style={{ color: 'var(--rust)', fontWeight: 700 }}>
                        {num(shop.open_reviews)}
                      </Link>
                    ) : '0'}
                  </td>
                  <td>
                    <span className="freshness">{ago(shop.last_successful_discovery_at)}</span>
                    {run && (
                      <div className="cell-note">
                        <RunStatus status={String(run['status'])} />
                        {run['quality_gate_passed'] === false && ' · kapu megbukott'}
                      </div>
                    )}
                  </td>
                  <td className="freshness">{ago(shop.last_price_refresh_at)}</td>
                  <td className="freshness">
                    {shop.next_discovery_at ? dateTime(shop.next_discovery_at) : '—'}
                  </td>
                  {canManage && (
                    <td className="right">
                      <ShopActiveToggle shopId={shop.id} csrfToken={session.csrfToken}
                                        active={shop.active} />
                      <ShopActions shopId={shop.id} csrfToken={session.csrfToken}
                                   disabled={shop.policy_disabled} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Sorok állapota */}
      <section>
        <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>Feldolgozási sorok</h2>
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Sor</th>
                <th className="right">Várakozik</th>
                <th className="right">Fut</th>
                <th className="right">Késleltetve</th>
                <th className="right">Hibás</th>
              </tr>
            </thead>
            <tbody>
              {queues.queues.filter((q) => q.waiting + q.active + q.delayed + q.failed > 0).length === 0 ? (
                <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 18 }}>
                  Minden sor üres.
                </td></tr>
              ) : queues.queues.map((q) => (
                <tr key={q.queue}>
                  <td className="num" style={{ fontSize: 12 }}>{q.queue}</td>
                  <td className="right num">{q.waiting}</td>
                  <td className="right num">{q.active}</td>
                  <td className="right num">{q.delayed}</td>
                  <td className="right num" style={{ color: q.failed > 0 ? 'var(--rust)' : undefined }}>
                    {q.failed}
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

function RunStatus({ status }: { status: string }) {
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
