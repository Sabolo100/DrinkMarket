import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { apiSafe, currentSession, ago } from '@/lib/api';
import { ProducerActions, MineButton, ApplyButton } from './ProducerActions';

export const dynamic = 'force-dynamic';

/**
 * Borászattár és jóváhagyás.
 *
 * Ez a képernyő old fel egy hosszú láncot: a `producers` tábla üres volt, a
 * bor kategóriában viszont a termelő KÖTELEZŐ mező — amíg nincs benne semmi,
 * egyetlen borpárosítás sem tud sikerülni. A jelöltek a webshopok
 * termékneveiből származnak, és kizárólag itt, emberi döntéssel válnak élessé.
 */

interface Producer {
  id: string;
  canonical_name: string;
  status: string;
  kind: string;
  fuzzy_blocked: boolean;
  candidate_score: number | null;
  evidence: {
    listings?: number; shops?: number; hasMarker?: boolean;
    personName?: boolean; examples?: string[]; minedAt?: string;
  } | null;
  proposed_at: string | null;
  decided_at: string | null;
  applied_at: string | null;
  applied_listing_count: number;
  linked_listings: number;
}

const TABS = [
  { key: 'proposed', label: 'Jóváhagyásra vár' },
  { key: 'active', label: 'Jóváhagyott' },
  { key: 'retired', label: 'Elvetett' },
] as const;

export default async function ProducersPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const status = typeof sp['status'] === 'string' ? sp['status'] : 'proposed';
  const search = typeof sp['search'] === 'string' ? sp['search'] : '';

  const qs = new URLSearchParams({ status });
  if (search) qs.set('search', search);

  const [data, session] = await Promise.all([
    apiSafe<{ items: Producer[]; counts: Record<string, number>; pendingApply: number }>(
      `/producers?${qs}`, { items: [], counts: {}, pendingApply: 0 },
    ),
    currentSession(),
  ]);

  const csrfToken = session?.csrfToken ?? '';
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHead
        title="Borászatok"
        lede="A termelő a bor azonosságának kötelező eleme. Amíg üres, a borpárosítás nem tud elindulni."
        actions={<MineButton csrfToken={csrfToken} />}
      />

      {total === 0 && (
        <div className="callout" style={{ marginBottom: 16 }}>
          <p className="label" style={{ marginBottom: 4 }}>Még nincs egyetlen borászat sem</p>
          <p style={{ margin: 0 }}>
            Indítsd el a <strong>Jelöltek frissítése</strong> gombbal. A rendszer a webshopok
            terméknevéből állít elő javaslatokat: leveszi a szőlőfajtát, a bortípust, a
            borvidéket és az évjáratot, és ami a név elején marad, azt kínálja fel.
          </p>
        </div>
      )}

      {data.pendingApply > 0 && (
        <div className="callout" style={{ marginBottom: 16 }}>
          <p className="label" style={{ marginBottom: 4 }}>
            {data.pendingApply} jóváhagyott borászat még nem hatott a katalógusra
          </p>
          <p style={{ margin: '0 0 8px' }}>
            A jóváhagyás önmagában nem tölti ki a termékek termelőjét: azt a rendszer a
            termék <strong>nevéből</strong> nyeri ki. Ehhez viszont nem kell újra begyűjteni
            a webshopot — a nevek már megvannak. Az újrakinyerés a jóváhagyás után magától
            elindul; ez a gomb csak akkor kell, ha megakadt, vagy ha közben bővült a
            fajta- és dűlőszótár.
          </p>
          <ApplyButton csrfToken={csrfToken} pending={data.pendingApply} />
        </div>
      )}

      {/* Szűrők */}
      <div className="row-tight" style={{ gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/boraszatok?status=${t.key}`}
            className={`btn btn-sm ${status === t.key ? '' : 'btn-ghost'}`}
          >
            {t.label}
            {data.counts[t.key] !== undefined && (
              <span className="num" style={{ marginLeft: 6, opacity: 0.7 }}>{data.counts[t.key]}</span>
            )}
          </Link>
        ))}
      </div>

      <div className="table-wrap">
        <table className="ledger">
          <thead>
            <tr>
              <th style={{ width: 60 }} className="right">Pont</th>
              <th>Borászat</th>
              <th className="right">Termék</th>
              <th className="right">Webshop</th>
              <th>Bizonyíték</th>
              <th>Példák a termékneveiből</th>
              {status === 'proposed' && <th style={{ width: 240 }}>Döntés</th>}
              {status !== 'proposed' && <th>Állapot</th>}
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr>
                <td colSpan={status === 'proposed' ? 7 : 7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {status === 'proposed'
                    ? 'Nincs jóváhagyásra váró jelölt.'
                    : status === 'active'
                      ? 'Még nincs jóváhagyott borászat.'
                      : 'Nincs elvetett jelölt.'}
                </td>
              </tr>
            ) : data.items.map((p) => {
              const ev = p.evidence ?? {};
              return (
                <tr key={p.id}>
                  <td className="right num faint">{p.candidate_score ?? '—'}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.canonical_name}</div>
                    {p.fuzzy_blocked && (
                      <span className="freshness muted" title="A névhasonlóság alapján nem párosítható: a Gere Attila és a Gere Zsolt két külön borászat.">
                        fuzzy tiltva
                      </span>
                    )}
                  </td>
                  <td className="right num">{ev.listings ?? '—'}</td>
                  <td className="right num">{ev.shops ?? '—'}</td>
                  <td>
                    <div className="row-tight" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {ev.hasMarker && (
                        <span className="chip chip-verified" title="A név termelőnév-jelölőt tartalmaz (Château, Domaine, Pince, Borbirtok). Ez önmagában erős bizonyíték.">
                          jelölős
                        </span>
                      )}
                      {ev.personName && (
                        <span className="chip chip-review" title="Vezetéknév + keresztnév minta. A fuzzy egyezés ilyenkor tilos.">
                          személynév
                        </span>
                      )}
                      {(ev.shops ?? 0) >= 3 && (
                        <span className="chip chip-neutral" title="Több webshopban is szerepel - erős támogatottság.">
                          {ev.shops} webshop
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="faint" style={{ fontSize: 11, maxWidth: 380 }}>
                    {(ev.examples ?? []).slice(0, 2).map((e, i) => (
                      <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {e}
                      </div>
                    ))}
                  </td>
                  {status === 'proposed' ? (
                    <td>
                      <ProducerActions
                        id={p.id}
                        name={p.canonical_name}
                        personName={p.fuzzy_blocked}
                        csrfToken={csrfToken}
                      />
                    </td>
                  ) : (
                    <td className="freshness muted">
                      {p.status === 'active' ? 'jóváhagyva' : 'elvetve'}
                      {p.decided_at ? ` · ${ago(p.decided_at)}` : ''}
                      {p.status === 'active' && (
                        p.applied_at ? (
                          <div className="num">
                            {p.linked_listings > 0
                              ? `${p.linked_listings} terméken felismerve`
                              : 'alkalmazva · egy terméknév sem illeszkedett'}
                          </div>
                        ) : (
                          <div className="chip chip-review" title="A jóváhagyás megtörtént, de a katalóguson még nem futott le az újrakinyerés.">
                            még nem alkalmazva
                          </div>
                        )
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {status === 'proposed' && data.items.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 12, maxWidth: '70ch' }}>
          A jelöltek a webshopok termékneveiből származnak, és <strong>javaslatok</strong> —
          semmi nem lép életbe jóváhagyás nélkül. Ami nem borászat (pohármárka, pálinkafőzde,
          kategórianév), azt nyugodtan vesd el: a sor megmarad, így egy későbbi bányászat nem
          fogja újra felkínálni.
        </p>
      )}
    </>
  );
}
