import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { DeltaBadge, ShopDot } from '@/components/Signals';
import { apiSafe, dateTime, huf, num } from '@/lib/api';

export const dynamic = 'force-dynamic';

const EVENT: Record<string, { label: string; tone: string; glyph: string }> = {
  first_seen:           { label: 'első észlelés', tone: 'chip-neutral', glyph: '+' },
  price_changed:        { label: 'árváltozás', tone: 'chip-neutral', glyph: '↕' },
  availability_changed: { label: 'készletváltozás', tone: 'chip-neutral', glyph: '⌀' },
  sale_started:         { label: 'akció indult', tone: 'chip-sale', glyph: '%' },
  sale_ended:           { label: 'akció véget ért', tone: 'chip-neutral', glyph: '%' },
  listing_missing:      { label: 'listing eltűnt', tone: 'chip-technical', glyph: '⌀' },
  listing_returned:     { label: 'listing visszatért', tone: 'chip-verified', glyph: '↩' },
  identity_drift:       { label: 'identitás-eltolódás', tone: 'chip-rejected', glyph: '⇄' },
  price_anomaly:        { label: 'áranomália', tone: 'chip-rejected', glyph: '!' },
};

export default async function ChangesPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) qs.set(k, v);
  qs.set('days', qs.get('days') ?? '7');

  const [data, shops] = await Promise.all([
    apiSafe<{
      items: Array<Record<string, unknown>>;
      total: number; page: number; pageSize: number; hasMore: boolean;
    }>(`/dashboard/changes?${qs.toString()}`,
      { items: [], total: 0, page: 1, pageSize: 50, hasMore: false }),
    apiSafe<{ items: Array<{ id: string; name: string }> }>('/shops', { items: [] }),
  ]);

  return (
    <>
      <PageHead
        title="Árváltozások"
        lede={
          <>Eseményalapú történet: a rendszer nem minden megfigyelést tárol új sorként,
          csak a tényleges változásokat. Az extrém és nagyságrendi ugrás karanténba kerül —
          nem tűnik el csendben, de nem is jelenik meg aktuális árként.</>
        }
        actions={
          <Link className="btn btn-sm" href="/api/v1/reports/export?format=xlsx&scope=changes">
            XLSX export
          </Link>
        }
      />

      <form method="get" className="toolbar">
        <select name="days" defaultValue={String(sp['days'] ?? '7')} style={{ width: 'auto' }}
                aria-label="Időszak">
          <option value="1">Elmúlt 24 óra</option>
          <option value="7">Elmúlt 7 nap</option>
          <option value="30">Elmúlt 30 nap</option>
          <option value="90">Elmúlt 90 nap</option>
        </select>
        <select name="significance" defaultValue={String(sp['significance'] ?? '')} style={{ width: 'auto' }}
                aria-label="Jelentőség">
          <option value="">Minden változás</option>
          <option value="significant">Csak jelentős</option>
          <option value="extreme">Csak extrém</option>
        </select>
        <select name="eventType" defaultValue={String(sp['eventType'] ?? '')} style={{ width: 'auto' }}
                aria-label="Esemény típusa">
          <option value="">Minden esemény</option>
          {Object.entries(EVENT).map(([key, e]) => (
            <option key={key} value={key}>{e.label}</option>
          ))}
        </select>
        <select name="shopId" defaultValue={String(sp['shopId'] ?? '')} style={{ width: 'auto' }}
                aria-label="Webshop">
          <option value="">Minden webshop</option>
          {shops.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="btn btn-sm btn-primary" type="submit">Szűrés</button>
        <div className="spacer" />
        <span className="label num">{num(data.total)} esemény</span>
      </form>

      {data.items.length === 0 ? (
        <div className="empty">
          <div className="display">Nincs esemény a választott időszakban</div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Idő</th>
                <th>Esemény</th>
                <th className="sticky-col" style={{ minWidth: 240 }}>Termék</th>
                <th>Webshop</th>
                <th className="right">Előző ár</th>
                <th className="right">Új ár</th>
                <th className="right">Változás</th>
                <th>Jelentőség</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => {
                const meta = EVENT[String(e['event_type'])] ?? { label: String(e['event_type']), tone: 'chip-neutral', glyph: '·' };
                return (
                  <tr key={String(e['id'])}>
                    <td className="freshness">{dateTime(e['occurred_at'] as string)}</td>
                    <td><span className={`chip ${meta.tone}`} data-glyph={meta.glyph}>{meta.label}</span></td>
                    <td className="sticky-col">
                      {e['canonical_variant_id'] ? (
                        <Link href={`/termek/${e['canonical_variant_id']}`} style={{ color: 'var(--ink)' }}>
                          {String(e['canonical_display_name'])}
                        </Link>
                      ) : (
                        <span className="muted">{String(e['listing_name'])}</span>
                      )}
                      <div className="cell-note">
                        <a href={String(e['canonical_url'])} target="_blank" rel="noopener noreferrer nofollow">
                          {String(e['listing_name'])} ↗
                        </a>
                      </div>
                    </td>
                    <td>
                      <span className="row-tight" style={{ gap: 6 }}>
                        <ShopDot color={e['brand_color'] as string} />
                        <span style={{ fontSize: 12 }}>{String(e['shop_name'])}</span>
                      </span>
                    </td>
                    <td className="right num">{e['previous_price_huf'] ? huf(Number(e['previous_price_huf'])) : '—'}</td>
                    <td className="right num">{e['new_price_huf'] ? huf(Number(e['new_price_huf'])) : '—'}</td>
                    <td className="right"><DeltaBadge value={e['delta_pct'] as number} invert /></td>
                    <td>
                      {e['significance'] === 'extreme'
                        ? <span className="chip chip-rejected" data-glyph="!" title="Karanténba került, nem publikálódik aktuális árként.">extrém</span>
                        : e['significance'] === 'significant'
                          ? <span className="chip chip-review" data-glyph="~">jelentős</span>
                          : <span className="chip chip-neutral" data-glyph="·">normál</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
