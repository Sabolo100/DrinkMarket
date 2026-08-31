/**
 * Ártörténet — kézzel rajzolt SVG, könyvtár nélkül.
 *
 * A rajz a főkönyvi rács logikáját követi: hajszálvonalak, táblázatos számok,
 * webshoponként egy vonal a bolt saját színével. Nincs animált csillogás,
 * nincs tooltip-cirkusz — egy főkönyvi diagram olvashatóan.
 */
import { hufShort, dateOnly } from '@/lib/format';

interface Point {
  observed_at: string;
  price_huf: number | null;
  shop_id: string;
  shop_key: string;
  shop_name: string;
  brand_color: string | null;
}

const W = 960;
const H = 300;
const PAD = { top: 16, right: 96, bottom: 30, left: 62 };

export function PriceHistoryChart({ points }: { points: Array<Record<string, unknown>> }) {
  const data = points
    .map((p) => ({
      observed_at: String(p['observed_at']),
      price_huf: p['price_huf'] === null ? null : Number(p['price_huf']),
      shop_id: String(p['shop_id']),
      shop_key: String(p['shop_key']),
      shop_name: String(p['shop_name']),
      brand_color: (p['brand_color'] as string | null) ?? null,
    }))
    .filter((p): p is Point & { price_huf: number } => p.price_huf !== null && p.price_huf > 0);

  if (data.length < 2) {
    return <p className="muted" style={{ fontSize: 13 }}>Még nincs elég megfigyelés a grafikonhoz.</p>;
  }

  const byShop = new Map<string, Point[]>();
  for (const p of data) {
    const list = byShop.get(p.shop_id) ?? [];
    list.push(p);
    byShop.set(p.shop_id, list);
  }

  const times = data.map((p) => new Date(p.observed_at).getTime());
  const prices = data.map((p) => p.price_huf!);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const pMinRaw = Math.min(...prices);
  const pMaxRaw = Math.max(...prices);
  const padding = Math.max(200, (pMaxRaw - pMinRaw) * 0.12);
  const pMin = Math.max(0, pMinRaw - padding);
  const pMax = pMaxRaw + padding;

  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (p: number) => PAD.top + (1 - (p - pMin) / Math.max(1, pMax - pMin)) * (H - PAD.top - PAD.bottom);

  const yTicks = 5;
  const xTicks = 6;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart"
           role="img"
           aria-label={`Ártörténet ${byShop.size} webshop adataival, ${hufShort(pMinRaw)} és ${hufShort(pMaxRaw)} forint között.`}>
        {/* Vízszintes rács */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const value = pMin + ((pMax - pMin) / yTicks) * i;
          const yy = y(value);
          return (
            <g key={`y${i}`}>
              <line className="grid-line" x1={PAD.left} x2={W - PAD.right} y1={yy} y2={yy} />
              <text className="axis-text" x={PAD.left - 8} y={yy + 3} textAnchor="end">
                {hufShort(Math.round(value))}
              </text>
            </g>
          );
        })}

        {/* Időtengely */}
        {Array.from({ length: xTicks + 1 }, (_, i) => {
          const t = t0 + ((t1 - t0) / xTicks) * i;
          const xx = x(t);
          return (
            <g key={`x${i}`}>
              <line className="grid-line" x1={xx} x2={xx} y1={PAD.top} y2={H - PAD.bottom} opacity={0.5} />
              <text className="axis-text" x={xx} y={H - PAD.bottom + 14} textAnchor="middle">
                {dateOnly(new Date(t))}
              </text>
            </g>
          );
        })}

        <line className="axis-line" x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} />
        <line className="axis-line" x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} />

        {/* Webshoponkénti vonalak — lépcsős, mert az ár diszkrét eseményekben változik */}
        {[...byShop.entries()].map(([shopId, series]) => {
          const sorted = [...series].sort(
            (a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime(),
          );
          const colour = sorted[0]?.brand_color || 'var(--ink-2)';
          let d = '';
          sorted.forEach((p, i) => {
            const px = x(new Date(p.observed_at).getTime());
            const py = y(p.price_huf!);
            if (i === 0) d += `M ${px.toFixed(1)} ${py.toFixed(1)}`;
            else {
              const prev = sorted[i - 1]!;
              const prevY = y(prev.price_huf!);
              d += ` L ${px.toFixed(1)} ${prevY.toFixed(1)} L ${px.toFixed(1)} ${py.toFixed(1)}`;
            }
          });
          const last = sorted[sorted.length - 1]!;
          return (
            <g key={shopId}>
              <path className="series" d={d} stroke={colour} />
              <circle className="series-dot" cx={x(new Date(last.observed_at).getTime())}
                      cy={y(last.price_huf!)} r={3.5} fill={colour} />
              <text x={W - PAD.right + 8} y={y(last.price_huf!) + 3}
                    className="axis-text" fill={colour} style={{ fontWeight: 600 }}>
                {last.shop_name.slice(0, 12)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="row-tight" style={{ gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
        {[...byShop.entries()].map(([shopId, series]) => (
          <span key={shopId} className="row-tight" style={{ gap: 5, fontSize: 11 }}>
            <span className="shop-dot" style={{ background: series[0]?.brand_color || 'var(--ink-2)' }} />
            {series[0]?.shop_name}
            <span className="faint num">({series.length} megfigyelés)</span>
          </span>
        ))}
      </div>
    </div>
  );
}
