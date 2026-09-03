import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { apiSafe, currentSession } from '@/lib/api';
import { MergeGroupCard } from './MergeBoard';

export const dynamic = 'force-dynamic';

/**
 * Borászatjelöltek összevonása.
 *
 * A bányászat n-gramokból dolgozik, ezért ugyanarról a pincészetről több
 * jelöltet is előhoz — „Sauska Brut", „Sauska Extra Dry", „Sauska Puttonyos" —,
 * és külön sorra teszi a „Bock"-ot meg a „Bock Pince"-t.
 *
 * Ez nem kozmetikai gond. Amíg ezek külön `producer` sorok, a boraik KÜLÖN
 * termelőhöz tartoznak, és a párosítás soha nem tudja összekötni őket: a
 * termelő a bor kötelező azonosságmezője. Egy szétszórt borászat annyi, mintha
 * ott sem lenne.
 */

export interface MergeMember {
  id: string;
  canonicalName: string;
  status: string;
  linkedListings: number;
  candidateScore: number | null;
  personName: boolean;
  fuzzyBlocked: boolean;
}

export interface MergeGroup {
  key: string;
  kind: 'prefix' | 'token';
  confidence: 'high' | 'medium';
  suggestedKeepId: string;
  members: MergeMember[];
  warnings: string[];
}

const TABS = [
  { key: 'all', label: 'Minden javaslat' },
  { key: 'high', label: 'Biztos' },
  { key: 'medium', label: 'Emberi szem kell' },
] as const;

export default async function ProducerMergePage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const confidence = typeof sp['confidence'] === 'string' ? sp['confidence'] : 'all';
  const search = typeof sp['search'] === 'string' ? sp['search'] : '';

  const qs = new URLSearchParams({ confidence, limit: '150' });
  if (search) qs.set('search', search);

  const [data, session] = await Promise.all([
    apiSafe<{
      items: MergeGroup[]; total: number; hasMore: boolean; redundant: number;
      counts: { high: number; medium: number };
    }>(
      `/producers/merge-groups?${qs}`,
      { items: [], total: 0, hasMore: false, redundant: 0, counts: { high: 0, medium: 0 } },
    ),
    currentSession(),
  ]);

  const csrfToken = session?.csrfToken ?? '';
  const canDecide = ['catalog_manager', 'admin'].includes(session?.user.role ?? '');

  return (
    <>
      <PageHead
        title="Borászatok összevonása"
        lede="Ugyanaz a pincészet több néven. Amíg külön sorok, a boraik külön termelőhöz tartoznak."
        actions={<Link href="/boraszatok" className="btn btn-sm btn-ghost">Vissza a listához</Link>}
      />

      {data.total === 0 ? (
        <div className="callout">
          <p className="label" style={{ marginBottom: 4 }}>Nincs összevonási javaslat</p>
          <p style={{ margin: 0 }}>
            A jelenlegi jelöltek között nem találtunk olyan neveket, amelyek ugyanarra a
            borászatra mutatnának. Ha mégis tudsz ilyet, a keresővel előhozhatod és
            kézzel is összevonhatod.
          </p>
        </div>
      ) : (
        <div className="callout" style={{ marginBottom: 16 }}>
          <p className="label" style={{ marginBottom: 4 }}>
            {data.total} csoport · {data.redundant} fölösleges jelöltsor
          </p>
          <p style={{ margin: 0 }}>
            A <strong>megtartott</strong> sor viszi tovább a csoportot: minden termék, dűlő és
            márka átkerül hozzá, a beolvadt nevek pedig <strong>jóváhagyott aliasszá</strong>{' '}
            válnak. Ez az igazi hozam — a következő kinyerés a „Sauska Brut" névből is a
            Sauska borászatot fogja felismerni. A beolvadt sorok nem törlődnek, csak
            lezárulnak, így a döntés visszakereshető.
          </p>
        </div>
      )}

      {/* Szűrők */}
      <div className="row-tight" style={{ gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/boraszatok/osszevonas?confidence=${t.key}${search ? `&search=${encodeURIComponent(search)}` : ''}`}
            className={`btn btn-sm ${confidence === t.key ? '' : 'btn-ghost'}`}
          >
            {t.label}
            {t.key !== 'all' && (
              <span className="num" style={{ marginLeft: 6, opacity: 0.7 }}>
                {t.key === 'high' ? data.counts.high : data.counts.medium}
              </span>
            )}
          </Link>
        ))}
        <span className="freshness" style={{ marginLeft: 'auto' }}>
          {data.items.length} megjelenítve{data.hasMore ? ' (szűkíts a keresővel)' : ''}
        </span>
      </div>

      {!canDecide && data.total > 0 && (
        <div className="callout" style={{ marginBottom: 16 }}>
          <p style={{ margin: 0 }}>
            Az összevonáshoz katalóguskezelői jogosultság kell. A javaslatok megtekinthetők.
          </p>
        </div>
      )}

      <div className="stack-4">
        {data.items.map((g) => (
          <MergeGroupCard key={g.key} group={g} csrfToken={csrfToken} canDecide={canDecide} />
        ))}
      </div>

      {data.total > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 'var(--s-5)', maxWidth: '70ch' }}>
          Az összevonás <strong>nem automatikus</strong>, és ez szándékos: a „Gere Attila" és a
          „Gere Zsolt" vezető szava azonos, mégis két külön borászat. Ahol ilyen gyanú van, a
          csoport figyelmeztetést visel — nézd meg a teljes neveket, mielőtt döntesz. Amit
          nem vonsz össze, az érintetlenül marad.
        </p>
      )}
    </>
  );
}
