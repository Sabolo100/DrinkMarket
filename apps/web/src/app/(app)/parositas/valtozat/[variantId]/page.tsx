import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { apiSafe, currentSession, ago } from '@/lib/api';
import { PairBoard } from './PairBoard';

export const dynamic = 'force-dynamic';

/**
 * Változat-központú párosítás-ellenőrzés.
 *
 * Az esetek páronként keletkeznek — egy termék hat boltban hat külön eset.
 * Az adatmodellben ez helyes, a munkavégzéshez viszont használhatatlan
 * húszezer tételnél: aki dönt, annak ugyanazt a bort hatszor kellene újra
 * megértenie.
 *
 * Itt egy képernyő = egy termék + minden nyitott boltja, és egy mentés =
 * több döntés. A képek nagyok, mert bornál a címke dönt gyorsabban, mint
 * bármelyik mezőtáblázat.
 */

export interface PairCase {
  id: string;
  case_type: string;
  row_version: number;
  reason_codes: string[];
  confidence: number | null;
  explanation: string | null;
  price_ratio: number | null;
  source_listing_id: string | null;
  raw_name: string | null;
  canonical_url: string | null;
  image_url: string | null;
  expression: string | null;
  vintage_value: number | null;
  volume_ml: number | null;
  pack_count: number | null;
  packaging_type: string | null;
  abv_percent: number | null;
  extraction_quality: number | null;
  colour: string | null;
  grape_names: string[] | null;
  shop_key: string | null;
  shop_name: string | null;
  brand_color: string | null;
  price_huf: number | null;
  availability_status: string | null;
  observed_at: string | null;
}

interface Canonical {
  id: string;
  canonical_display_name: string;
  vintage_value: number | null;
  volume_ml: number | null;
  pack_count: number | null;
  packaging_type: string | null;
  colour: string | null;
  grape_varieties: string[] | null;
  category_name: string | null;
  producer_name: string | null;
  brand_name: string | null;
  wine_style_name: string | null;
}

interface Verified {
  id: string;
  raw_name: string;
  image_url: string | null;
  shop_key: string;
  shop_name: string;
  brand_color: string | null;
  price_huf: number | null;
}

export default async function VariantReviewPage({
  params,
}: { params: Promise<{ variantId: string }> }) {
  const { variantId } = await params;

  const [data, session] = await Promise.all([
    apiSafe<{
      canonical: Canonical | null;
      verified: Verified[];
      cases: PairCase[];
      reasonLabels: Record<string, string>;
    }>(`/review-cases/variant/${variantId}`, {
      canonical: null, verified: [], cases: [], reasonLabels: {},
    }),
    currentSession(),
  ]);

  if (!data.canonical) {
    return (
      <>
        <PageHead title="Párosítás" lede="A termékváltozat nem található." />
        <Link href="/parositas/valtozatok" className="btn btn-sm">Vissza a sorhoz</Link>
      </>
    );
  }

  const c = data.canonical;
  // A kanonikus változatnak nincs saját képoszlopa a sémában — a már igazolt
  // boltok közül az elsőé áll be helyette.
  const canonImage = data.verified.find((v) => v.image_url)?.image_url ?? null;
  const prices = [
    ...data.verified.map((v) => v.price_huf),
    ...data.cases.map((x) => x.price_huf),
  ].filter((p): p is number => typeof p === 'number' && p > 0);
  const cheapest = prices.length ? Math.min(...prices) : null;

  const canDecide = ['reviewer', 'catalog_manager', 'source_manager', 'admin']
    .includes(session?.user.role ?? '');

  return (
    <>
      <PageHead
        title={c.canonical_display_name}
        lede={`${data.cases.length} webshop vár döntésre. ${data.verified.length} már igazolt.`}
        actions={
          <Link href="/parositas/valtozatok" className="btn btn-sm btn-ghost">
            Vissza a sorhoz
          </Link>
        }
      />

      <div className="pair-layout">
        {/* ── A kanonikus oldal ─────────────────────────────────────────── */}
        <div className="pair-canon">
          <div className="pair-canon-image">
            {canonImage
              ? <img src={canonImage} alt="" />
              : <span className="freshness">nincs kép</span>}
          </div>
          <div style={{ padding: 'var(--s-3)' }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
              {c.canonical_display_name}
            </div>
            <dl className="kv" style={{ fontSize: 11 }}>
              {c.producer_name && <><dt>Termelő</dt><dd>{c.producer_name}</dd></>}
              {c.brand_name && !c.producer_name && <><dt>Márka</dt><dd>{c.brand_name}</dd></>}
              {c.grape_varieties?.length ? <><dt>Fajta</dt><dd>{c.grape_varieties.join(', ')}</dd></> : null}
              {c.wine_style_name && <><dt>Típus</dt><dd>{c.wine_style_name}</dd></>}
              {c.colour && <><dt>Szín</dt><dd>{c.colour}</dd></>}
              {c.vintage_value && <><dt>Évjárat</dt><dd className="num">{c.vintage_value}</dd></>}
              {c.volume_ml && <><dt>Kiszerelés</dt><dd className="num">{c.volume_ml} ml</dd></>}
            </dl>

            {data.verified.length > 0 && (
              <div style={{ marginTop: 'var(--s-3)', paddingTop: 'var(--s-3)', borderTop: '1px solid var(--rule-faint)' }}>
                <div className="label" style={{ marginBottom: 4 }}>
                  Már igazolt ({data.verified.length})
                </div>
                {data.verified.map((v) => (
                  <div key={v.id} className="row-tight" style={{ justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                    <span>{v.shop_name}</span>
                    <span className="num">{v.price_huf ? `${v.price_huf.toLocaleString('hu-HU')} Ft` : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── A jelölt kártyák ──────────────────────────────────────────── */}
        <div>
          {data.cases.length === 0 ? (
            <div className="callout">
              <p style={{ margin: 0 }}>Ehhez a termékhez nincs nyitott döntés.</p>
            </div>
          ) : (
            <PairBoard
              cases={data.cases}
              cheapest={cheapest}
              canonical={{
                vintage: c.vintage_value, volumeMl: c.volume_ml,
                colour: c.colour, grapes: c.grape_varieties ?? [],
                packCount: c.pack_count, packagingType: c.packaging_type,
              }}
              reasonLabels={data.reasonLabels}
              csrfToken={session?.csrfToken ?? ''}
              canDecide={Boolean(canDecide)}
            />
          )}
        </div>
      </div>

      {data.cases.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 'var(--s-5)', maxWidth: '70ch' }}>
          A kártyák alapból <strong>függőben</strong> állnak — a mentés csak azt írja ki, amit
          megjelöltél. Ami függőben marad, az a sorban marad. Az eltérő adatokat a kártya
          kiemeli; ami mindkét oldalon egyezik, azt nem mutatjuk, mert nem segít a döntésben.
          {' '}Utolsó megfigyelés: {data.cases[0]?.observed_at ? ago(data.cases[0].observed_at) : '—'}.
        </p>
      )}
    </>
  );
}
