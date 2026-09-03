import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { apiSafe, ago } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * A párosítási sor termékenként.
 *
 * A klasszikus lista páronként sorol fel: egy termék hat boltban hat sor.
 * Húszezer tételnél ez nemcsak hosszú, hanem ismétlődő munka is — ugyanazt a
 * bort hatszor kell újra megérteni. Itt egy sor = egy termék, és a mögötte
 * lévő képernyőn egyszerre dönthetsz az összes boltjáról.
 */

interface GroupRow {
  canonical_variant_id: string;
  canonical_display_name: string;
  vintage_value: number | null;
  volume_ml: number | null;
  category_key: string | null;
  producer_name: string | null;
  open_cases: number;
  priority: number;
  confidence: number | null;
  has_ambiguous: boolean;
  shop_keys: string[];
  oldest_at: string;
  due_at: string | null;
  verified_shop_count: number;
  image_url: string | null;
}

export default async function GroupedReviewPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === 'string') qs.set(k, v);

  const data = await apiSafe<{ items: GroupRow[]; total: number; hasMore: boolean }>(
    `/review-cases/grouped?${qs}`, { items: [], total: 0, hasMore: false },
  );

  return (
    <>
      <PageHead
        title="Párosítások ellenőrzése"
        lede="Termékenként egy döntési képernyő — minden webshopjával együtt."
        actions={
          <Link href="/parositas" className="btn btn-sm btn-ghost">
            Klasszikus lista (esetenként)
          </Link>
        }
      />

      {data.total === 0 ? (
        <div className="callout callout-good">
          <p style={{ margin: 0 }}>Nincs nyitott döntés. A sor üres.</p>
        </div>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 12, marginBottom: 'var(--s-4)' }}>
            {data.total} termék vár döntésre. A sorrend a hozamot követi: elöl azok, ahol
            a rendszer szinte biztos, és ahol egyszerre több boltról lehet dönteni.
          </p>

          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th style={{ width: 52 }} />
                  <th>Termék</th>
                  <th className="right">Döntésre vár</th>
                  <th className="right">Már igazolt</th>
                  <th>Webshopok</th>
                  <th className="right">Erősség</th>
                  <th>Vár</th>
                  <th style={{ width: 110 }} />
                </tr>
              </thead>
              <tbody>
                {data.items.map((g) => (
                  <tr key={g.canonical_variant_id}>
                    <td>
                      {g.image_url
                        ? <img className="thumb" src={g.image_url} alt="" />
                        : <div className="thumb" />}
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{g.canonical_display_name}</div>
                      <div className="freshness">
                        {[g.producer_name, g.vintage_value, g.volume_ml ? `${g.volume_ml} ml` : null]
                          .filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="right num">
                      <strong>{g.open_cases}</strong>
                      {g.has_ambiguous && (
                        <div><span className="chip chip-review">kétes</span></div>
                      )}
                    </td>
                    <td className="right num faint">{g.verified_shop_count}</td>
                    <td className="freshness">{(g.shop_keys ?? []).join(', ')}</td>
                    <td className="right num faint">
                      {g.confidence !== null ? Number(g.confidence).toFixed(2) : '—'}
                    </td>
                    <td className="freshness" data-stale={g.due_at ? new Date(g.due_at) < new Date() : false}>
                      {ago(g.oldest_at)}
                    </td>
                    <td>
                      <Link
                        href={`/parositas/valtozat/${g.canonical_variant_id}`}
                        className="btn btn-sm"
                      >
                        Elbírálás
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
