import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { MatchStatusChip, ShopDot } from '@/components/Signals';
import { apiSafe, currentSession, ago, dateTime, num } from '@/lib/api';
import { RecheckBar } from './RecheckBar';

export const dynamic = 'force-dynamic';

interface Case {
  id: string; case_type: string; status: string; priority: number; title: string;
  reason_codes: string[]; confidence: number | null; created_at: string;
  due_at: string | null; candidate_count: number;
  canonical_variant_id: string | null; source_listing_id: string | null;
  canonical_display_name: string | null; vintage_value: number | null; volume_ml: number | null;
  listing_name: string | null; listing_url: string | null; image_url: string | null;
  shop_key: string | null; shop_name: string | null; brand_color: string | null;
  category_key: string | null; assignee_name: string | null; verified_shop_count: number;
}

const CASE_TYPE: Record<string, { label: string; tone: string; glyph: string }> = {
  new_match:          { label: 'Új párosítás', tone: 'chip-review', glyph: '+' },
  ambiguous:          { label: 'Több egyforma jelölt', tone: 'chip-review', glyph: '≈' },
  mapping_drift:      { label: 'Identitás-eltolódás', tone: 'chip-rejected', glyph: '⇄' },
  price_anomaly:      { label: 'Áranomália', tone: 'chip-rejected', glyph: '!' },
  identity_conflict:  { label: 'Identitás-ütközés', tone: 'chip-rejected', glyph: '×' },
  unclustered_listing:{ label: 'Klaszterezetlen listing', tone: 'chip-neutral', glyph: '·' },
  alias_proposal:     { label: 'Alias-javaslat', tone: 'chip-neutral', glyph: '≡' },
  data_quality:       { label: 'Adatminőség', tone: 'chip-review', glyph: '?' },
  listing_missing:    { label: 'Listing eltűnt', tone: 'chip-technical', glyph: '⌀' },
};

export default async function ReviewListPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string' && v) qs.set(k, v);

  const [data, shops, session] = await Promise.all([
    apiSafe<{
      items: Case[]; total: number; page: number; pageSize: number; hasMore: boolean;
      summary: Array<{ case_type: string; status: string; count: number }>;
      reasonLabels: Record<string, string>;
    }>(`/review-cases?${qs.toString()}`, {
      items: [], total: 0, page: 1, pageSize: 50, hasMore: false, summary: [], reasonLabels: {},
    }),
    apiSafe<{ items: Array<{ id: string; name: string; brand_color: string | null }> }>('/shops', { items: [] }),
    currentSession(),
  ]);

  const byType = new Map<string, number>();
  for (const s of data.summary) {
    byType.set(s.case_type, (byType.get(s.case_type) ?? 0) + s.count);
  }

  return (
    <>
      <PageHead
        title="Párosítások ellenőrzése"
        lede={
          <>Ez a felület a párosítási hibák megelőzésének fő eszköze. A rendszer inkább
          kér emberi döntést, mint hogy egy hasonló, de eltérő évjáratú, kiszerelésű vagy
          csomagolású termék árát mutassa. A sorrend a kockázatot követi: előbb az
          identitás-eltolódások, majd a sok webshopot érintő termékek.</>
        }
        actions={
          <div className="row-tight" style={{ gap: 10 }}>
            <span className="label num">{num(data.total)} nyitott eset</span>
            <Link href="/parositas/valtozatok" className="btn btn-sm">
              Termékenként (gyorsabb)
            </Link>
          </div>
        }
      />

      {/* A sor elavulhat: a javaslatok nem frissülnek maguktól attól, hogy
          közben jóváhagytál egy borászatot. Ez a sáv csak akkor jelenik meg,
          amikor tényleg történt valami. */}
      <RecheckBar csrfToken={session?.csrfToken ?? ''} />

      {/* Eset-típusok gyors szűrője */}
      <div className="toolbar">
        <Link className="btn btn-sm" href="/parositas"
              aria-current={!sp['caseType'] ? 'page' : undefined}>
          Mind ({num(data.total)})
        </Link>
        {[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => {
          const meta = CASE_TYPE[type] ?? { label: type, tone: 'chip-neutral', glyph: '·' };
          const active = sp['caseType'] === type;
          return (
            <Link key={type} href={`/parositas?caseType=${type}`}
                  className={`chip ${meta.tone}`} data-glyph={meta.glyph}
                  style={{ textDecoration: 'none', opacity: active ? 1 : 0.75,
                           outline: active ? '2px solid var(--wine)' : 'none', outlineOffset: 2 }}>
              {meta.label} · {count}
            </Link>
          );
        })}
        <div className="spacer" />
        <form method="get" className="row-tight">
          {sp['caseType'] && <input type="hidden" name="caseType" value={String(sp['caseType'])} />}
          <select name="shopId" defaultValue={String(sp['shopId'] ?? '')} style={{ width: 'auto' }}
                  aria-label="Webshop szűrő">
            <option value="">Minden webshop</option>
            {shops.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button className="btn btn-sm" type="submit">Szűrés</button>
        </form>
      </div>

      {data.items.length === 0 ? (
        <div className="empty">
          <div className="display">Nincs nyitott ellenőrzési eset</div>
          <p style={{ fontSize: 13 }}>
            Ez jó jel: minden párosítás vagy bizonyított, vagy indokoltan elutasított.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th style={{ width: 44 }}></th>
                <th className="sticky-col" style={{ left: 44 }}>Eset</th>
                <th>Típus</th>
                <th>Webshop</th>
                <th>Indoklás</th>
                <th className="right">Erősség</th>
                <th className="right">Jelölt</th>
                <th className="right">Érintett bolt</th>
                <th>Határidő</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => {
                const meta = CASE_TYPE[c.case_type] ?? { label: c.case_type, tone: 'chip-neutral', glyph: '·' };
                const overdue = c.due_at && new Date(c.due_at) < new Date();
                return (
                  <tr key={c.id}>
                    <td>
                      {c.image_url
                        ? <img className="thumb" src={c.image_url} alt="" loading="lazy" />
                        : <div className="thumb" aria-hidden="true" />}
                    </td>
                    <td className="sticky-col" style={{ left: 44 }}>
                      <Link href={`/parositas/${c.id}`} style={{ fontWeight: 500, color: 'var(--ink)' }}>
                        {c.canonical_display_name ?? c.title}
                      </Link>
                      {c.listing_name && (
                        <div className="cell-note">
                          webshop neve: <em>{c.listing_name}</em>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`chip ${meta.tone}`} data-glyph={meta.glyph}>{meta.label}</span>
                    </td>
                    <td>
                      {c.shop_name ? (
                        <span className="row-tight" style={{ gap: 6 }}>
                          <ShopDot color={c.brand_color} />
                          <span style={{ fontSize: 12 }}>{c.shop_name}</span>
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ maxWidth: 260 }}>
                      <div className="stack-2">
                        {c.reason_codes.slice(0, 2).map((code) => (
                          <span key={code} style={{ fontSize: 11, color: 'var(--ink-2)' }}>
                            {data.reasonLabels[code] ?? code}
                          </span>
                        ))}
                        {c.reason_codes.length > 2 && (
                          <span className="faint" style={{ fontSize: 10 }}>
                            +{c.reason_codes.length - 2} további indok
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="right num">
                      {c.confidence !== null ? c.confidence.toFixed(3) : '—'}
                    </td>
                    <td className="right num">{c.candidate_count}</td>
                    <td className="right num">{c.verified_shop_count}</td>
                    <td>
                      <span className="freshness" data-stale={overdue ? 'true' : undefined}>
                        {c.due_at ? (overdue ? `lejárt · ${ago(c.due_at)}` : dateTime(c.due_at)) : '—'}
                      </span>
                      <div className="cell-note">nyitva {ago(c.created_at)}</div>
                    </td>
                    <td className="right">
                      <Link className="btn btn-sm btn-primary" href={`/parositas/${c.id}`}>
                        Elbírálás
                      </Link>
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
