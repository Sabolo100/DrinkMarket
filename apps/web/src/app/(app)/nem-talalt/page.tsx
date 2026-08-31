import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { HealthChip, MatchStatusChip, ShopDot } from '@/components/Signals';
import { apiSafe, ago, dateTime, num, volume } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Nem talált termékek (spec 25.).
 *
 * A felület élesen elválasztja azt, hogy „egészséges forrás mellett tényleg
 * nincs ilyen termék” attól, hogy „technikai hiba miatt nem tudjuk”.
 * Egyetlen keresési hiba sem eredményezhet „nincs ilyen termék” állapotot.
 */

const BUCKETS: Record<string, { label: string; tone: string; glyph: string; help: string }> = {
  healthy_not_found: {
    label: 'Egészséges keresés után nincs', tone: 'chip-neutral', glyph: '—',
    help: 'A forrás egészséges volt, a teljes keresési terv lefutott, mégsem lett elfogadható jelölt. Ez üzleti tény.',
  },
  technical: {
    label: 'Technikai hiba miatt nem ellenőrizhető', tone: 'chip-technical', glyph: '!',
    help: 'A forrás állapota vagy a keresés hiányossága miatt NEM vonható le üzleti következtetés.',
  },
  uncertain_candidate: {
    label: 'Van jelölt, de bizonytalan', tone: 'chip-review', glyph: '?',
    help: 'Akadt jelölt, de a bizonyítékok nem elegendők az automatikus elfogadáshoz.',
  },
  listing_gone: {
    label: 'Korábbi listing eltűnt', tone: 'chip-technical', glyph: '⌀',
    help: 'A korábban párosított termékoldal eltűnt. A kapcsolat nem törlődött, újrakeresés indult.',
  },
  all_rejected: {
    label: 'Minden jelölt elutasítva', tone: 'chip-rejected', glyph: '×',
    help: 'A reviewer vagy a hard gate minden jelöltet kizárt.',
  },
  other: { label: 'Egyéb', tone: 'chip-neutral', glyph: '·', help: '' },
};

interface Row {
  canonical_variant_id: string; shop_id: string; status: string;
  last_search_at: string | null; last_full_search_at: string | null;
  search_attempt_count: number; consecutive_no_match: number;
  next_search_at: string | null; best_rejected_score: number | null;
  primary_reason_code: string | null; reason_codes: string[];
  canonical_display_name: string; vintage_value: number | null; volume_ml: number | null;
  category_key: string; shop_name: string; shop_key: string; health_status: string;
  bucket: string;
  recent_searches: Array<{
    startedAt: string; outcome: string; channels: string[];
    candidates: number; reasonCodes: string[];
  }> | null;
}

export default async function UnmatchedPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) qs.set(k, v);

  const [data, shops] = await Promise.all([
    apiSafe<{
      items: Row[]; total: number; page: number; pageSize: number; hasMore: boolean;
      buckets: Array<{ bucket: string; count: number }>;
      reasonLabels: Record<string, string>;
    }>(`/dashboard/unmatched?${qs.toString()}`, {
      items: [], total: 0, page: 1, pageSize: 50, hasMore: false, buckets: [], reasonLabels: {},
    }),
    apiSafe<{ items: Array<{ id: string; name: string }> }>('/shops', { items: [] }),
  ]);

  const anchorShopId = typeof sp['anchorShopId'] === 'string' ? sp['anchorShopId'] : '';
  const anchorShop = shops.items.find((s) => s.id === anchorShopId);

  return (
    <>
      <PageHead
        title="Nem talált termékek"
        lede={
          anchorShop
            ? <>A(z) <strong>{anchorShop.name}</strong> termékeire mutatja, mely más webshopokban
              nincs még igazolt pár. A „nincs ilyen termék” csak egészséges forrás és
              lefuttatott teljes keresési terv mellett állítható.</>
            : <>Kanonikus termék × webshop bontásban mutatja, hol nincs még igazolt listing.
              A technikai hibát élesen elválasztjuk attól, hogy a webshopban valóban nincs
              ilyen termék.</>
        }
        actions={
          <Link className="btn btn-sm" href="/api/v1/reports/export?format=xlsx&scope=unmatched">
            XLSX export
          </Link>
        }
      />

      <div className="toolbar">
        <Link className="btn btn-sm" href={`/nem-talalt${anchorShopId ? `?anchorShopId=${anchorShopId}` : ''}`}>
          Mind ({num(data.total)})
        </Link>
        {data.buckets.map((b) => {
          const meta = BUCKETS[b.bucket] ?? BUCKETS['other']!;
          const active = sp['bucket'] === b.bucket;
          const params = new URLSearchParams(qs);
          params.set('bucket', b.bucket);
          return (
            <Link key={b.bucket} href={`/nem-talalt?${params.toString()}`}
                  className={`chip ${meta.tone}`} data-glyph={meta.glyph} title={meta.help}
                  style={{ textDecoration: 'none',
                           outline: active ? '2px solid var(--wine)' : 'none', outlineOffset: 2 }}>
              {meta.label} · {b.count}
            </Link>
          );
        })}
        <div className="spacer" />
        <form method="get" className="row-tight">
          {anchorShopId && <input type="hidden" name="anchorShopId" value={anchorShopId} />}
          <select name="shopId" defaultValue={String(sp['shopId'] ?? '')} style={{ width: 'auto' }}
                  aria-label="Célwebshop">
            <option value="">Minden célwebshop</option>
            {shops.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="btn btn-sm" type="submit">Szűrés</button>
        </form>
      </div>

      {data.items.length === 0 ? (
        <div className="empty">
          <div className="display">Nincs megjelenítendő hiányzó pár</div>
          <p style={{ fontSize: 13 }}>Vagy minden termék párosított, vagy a szűrő túl szűk.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th className="sticky-col">Kanonikus termékváltozat</th>
                <th>Célwebshop</th>
                <th>Csoport</th>
                <th>Állapot</th>
                <th>Forrás</th>
                <th className="right">Próbálkozás</th>
                <th>Utolsó teljes keresés</th>
                <th>Következő keresés</th>
                <th>Fő indok</th>
                <th>Lefuttatott utak</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => {
                const meta = BUCKETS[row.bucket] ?? BUCKETS['other']!;
                const lastSearch = row.recent_searches?.[0];
                return (
                  <tr key={`${row.canonical_variant_id}-${row.shop_id}`}>
                    <td className="sticky-col">
                      <Link href={`/termek/${row.canonical_variant_id}`}
                            style={{ fontWeight: 500, color: 'var(--ink)' }}>
                        {row.canonical_display_name}
                      </Link>
                      <div className="cell-note">
                        {[row.category_key, row.vintage_value, volume(row.volume_ml)]
                          .filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td>
                      <span className="row-tight" style={{ gap: 6 }}>
                        <ShopDot />
                        <Link href={`/webshopok/${row.shop_id}`}>{row.shop_name}</Link>
                      </span>
                    </td>
                    <td>
                      <span className={`chip ${meta.tone}`} data-glyph={meta.glyph} title={meta.help}>
                        {meta.label}
                      </span>
                    </td>
                    <td><MatchStatusChip status={row.status} /></td>
                    <td><HealthChip status={row.health_status} /></td>
                    <td className="right num">
                      {row.search_attempt_count}
                      {row.consecutive_no_match > 0 && (
                        <div className="cell-note">{row.consecutive_no_match} egymás után üres</div>
                      )}
                    </td>
                    <td className="freshness">{ago(row.last_full_search_at)}</td>
                    <td className="freshness">
                      {row.next_search_at ? dateTime(row.next_search_at) : '—'}
                    </td>
                    <td style={{ maxWidth: 220 }}>
                      <span style={{ fontSize: 11 }}>
                        {row.primary_reason_code
                          ? (data.reasonLabels[row.primary_reason_code] ?? row.primary_reason_code)
                          : '—'}
                      </span>
                      {row.best_rejected_score !== null && (
                        <div className="cell-note num">
                          legjobb elutasított: {row.best_rejected_score.toFixed(3)}
                        </div>
                      )}
                    </td>
                    <td>
                      {lastSearch ? (
                        <>
                          <span className="freshness">
                            {lastSearch.channels.length} csatorna · {lastSearch.candidates} jelölt
                          </span>
                          <div className="cell-note">{ago(lastSearch.startedAt)}</div>
                        </>
                      ) : <span className="faint" style={{ fontSize: 11 }}>nincs napló</span>}
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
