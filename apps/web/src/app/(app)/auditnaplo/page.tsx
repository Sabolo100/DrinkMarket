import { PageHead } from '@/components/Shell';
import { apiSafe, dateTime, num } from '@/lib/api';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'bejelentkezés',
  'auth.login_failed': 'sikertelen bejelentkezés',
  'auth.logout': 'kijelentkezés',
  'auth.password_changed': 'jelszóváltás',
  'auth.invite_accepted': 'meghívó elfogadva',
  'user.invited': 'felhasználó meghívva',
  'user.role_changed': 'szerepkör módosítva',
  'user.status_changed': 'felhasználó állapota módosítva',
  'product.created': 'termék létrehozva',
  'product.updated': 'termék módosítva',
  'product.approved': 'termék jóváhagyva',
  'product.suspended': 'termék felfüggesztve',
  'product.merged': 'termékek összevonva',
  'product.tracked': 'figyelőlistára került',
  'product.untracked': 'figyelőlistáról levéve',
  'product.search_now': 'azonnali keresés indítva',
  'review.approved': 'párosítás jóváhagyva',
  'review.rejected': 'párosítás elutasítva',
  'review.candidate_selected': 'másik jelölt kiválasztva',
  'review.marked_not_found': 'nincs megfelelő termék',
  'review.canonical_fixed': 'kanonikus adat javítva',
  'review.promote_listing': 'listingből új kanonikus változat',
  'shop.updated': 'webshop módosítva',
  'shop.discovery_triggered': 'felderítés indítva',
  'shop.health_check': 'health check indítva',
  'shop.price_refresh': 'árfrissítés indítva',
  'settings.updated': 'beállítás módosítva',
  'feature_flag.updated': 'funkciókapcsoló módosítva',
  'alias.proposed': 'alias javasolva',
  'alias.approved': 'alias jóváhagyva',
  'alias.deactivated': 'alias kikapcsolva',
  'negative_alias.created': 'kizáró névpár rögzítve',
  'import.uploaded': 'import feltöltve',
  'import.validated': 'import ellenőrizve',
  'import.committed': 'import véglegesítve',
  'alert.resolved': 'riasztás lezárva',
  'golden.pair_added': 'golden pár hozzáadva',
};

export default async function AuditPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) qs.set(k, v);
  qs.set('days', qs.get('days') ?? '30');

  const data = await apiSafe<{
    items: Array<Record<string, unknown>>;
    total: number; page: number; pageSize: number; hasMore: boolean;
  }>(`/audit-log?${qs.toString()}`, { items: [], total: 0, page: 1, pageSize: 50, hasMore: false });

  return (
    <>
      <PageHead
        title="Auditnapló"
        lede={
          <>Az auditnapló csak bővíthető: módosítani és törölni adatbázis-szinten sem
          lehet. Minden módosító művelet, minden jóváhagyás és minden policy-változás
          visszakereshető.</>
        }
      />

      <form method="get" className="toolbar">
        <select name="days" defaultValue={String(sp['days'] ?? '30')} style={{ width: 'auto' }}
                aria-label="Időszak">
          <option value="1">Elmúlt 24 óra</option>
          <option value="7">Elmúlt 7 nap</option>
          <option value="30">Elmúlt 30 nap</option>
          <option value="90">Elmúlt 90 nap</option>
          <option value="365">Elmúlt év</option>
        </select>
        <select name="entityType" defaultValue={String(sp['entityType'] ?? '')} style={{ width: 'auto' }}
                aria-label="Entitás típusa">
          <option value="">Minden entitás</option>
          <option value="canonical_variant">Kanonikus termék</option>
          <option value="source_listing">Webshop listing</option>
          <option value="review_case">Ellenőrzési eset</option>
          <option value="shop">Webshop</option>
          <option value="user">Felhasználó</option>
          <option value="setting">Beállítás</option>
          <option value="feature_flag">Funkciókapcsoló</option>
          <option value="alias">Alias</option>
          <option value="import_batch">Import</option>
        </select>
        <div className="grow">
          <input type="text" name="entityId" defaultValue={String(sp['entityId'] ?? '')}
                 placeholder="Entitás azonosító (UUID vagy kulcs)…" aria-label="Entitás azonosító" />
        </div>
        <button className="btn btn-sm btn-primary" type="submit">Szűrés</button>
        <div className="spacer" />
        <span className="label num">{num(data.total)} bejegyzés</span>
      </form>

      {data.items.length === 0 ? (
        <div className="empty">
          <div className="display">Nincs naplóbejegyzés a szűrésre</div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Idő</th>
                <th>Ki</th>
                <th>Művelet</th>
                <th>Entitás</th>
                <th>Összefoglaló</th>
                <th>Változás</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={String(e['id'])}>
                  <td className="freshness" style={{ whiteSpace: 'nowrap' }}>
                    {dateTime(e['occurred_at'] as string)}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {e['actor_name'] ? (
                      <>
                        <div>{String(e['actor_name'])}</div>
                        <div className="cell-note">{String(e['actor_email'] ?? '')}</div>
                      </>
                    ) : (
                      <span className="chip chip-neutral" data-glyph="⚙">
                        {String(e['actor_kind'] ?? 'rendszer')}
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {ACTION_LABEL[String(e['action'])] ?? String(e['action'])}
                    <div className="cell-note num">{String(e['action'])}</div>
                  </td>
                  <td style={{ fontSize: 11 }} className="muted">
                    {String(e['entity_type'])}
                    {e['entity_id'] ? (
                      <div className="cell-note num" style={{ wordBreak: 'break-all', maxWidth: 200 }}>
                        {String(e['entity_id']).slice(0, 36)}
                      </div>
                    ) : null}
                  </td>
                  <td style={{ fontSize: 12, maxWidth: 320 }}>{String(e['summary'] ?? '—')}</td>
                  <td>
                    {(e['before_state'] || e['after_state']) ? (
                      <details>
                        <summary className="label" style={{ cursor: 'pointer' }}>előtte / utána</summary>
                        <pre className="evidence-note" style={{
                          margin: '4px 0 0', whiteSpace: 'pre-wrap',
                          maxWidth: 420, maxHeight: 180, overflow: 'auto',
                        }}>
{e['before_state'] ? `— ELŐTTE —\n${JSON.stringify(e['before_state'], null, 1)}\n\n` : ''}
{e['after_state'] ? `— UTÁNA —\n${JSON.stringify(e['after_state'], null, 1)}` : ''}
                        </pre>
                      </details>
                    ) : <span className="faint">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
