/**
 * AZ ÁRSÁV-SÍN — a rendszer aláírás-motívuma.
 *
 * Egy vízszintes sín a piaci minimumtól a maximumig. Minden webshop ajánlata
 * egy jel a sínen; a medián hajszálvonal; a kiválasztott kiinduló webshop
 * jele tömör és magasabb. Ugyanez a rajz tér vissza a mátrix soraiban
 * (kicsiben) és a termékoldalon (nagyban).
 *
 * A stale (elavult) ajánlat SZAGGATOTT jelet kap — nem tűnhet frissnek
 * (spec 18.1, 31.2).
 */
import { hufShort } from '@/lib/format';

export interface RailOffer {
  shopId: string;
  shopKey?: string;
  shopName: string;
  shopColor?: string | null;
  priceHuf: number;
  rank?: number | null;
  stale?: boolean;
  onSale?: boolean;
}

interface Props {
  offers: RailOffer[];
  min?: number | null;
  max?: number | null;
  median?: number | null;
  anchorShopId?: string | null;
  size?: 'sm' | 'lg';
  showBounds?: boolean;
}

export function SpreadRail({
  offers, min, max, median, anchorShopId, size = 'sm', showBounds = true,
}: Props) {
  const valid = offers.filter((o) => Number.isFinite(o.priceHuf) && o.priceHuf > 0);
  if (valid.length === 0) {
    return <span className="faint" style={{ fontSize: 11 }}>nincs összehasonlítható ajánlat</span>;
  }

  const prices = valid.map((o) => o.priceHuf);
  const lo = min ?? Math.min(...prices);
  const hi = max ?? Math.max(...prices);
  const span = Math.max(1, hi - lo);
  const at = (price: number) => ((price - lo) / span) * 100;

  // Egyetlen ajánlatnál nincs valódi sáv: a jel középre kerül.
  const single = valid.length === 1 || hi === lo;

  return (
    <div className={size === 'lg' ? 'rail rail-lg' : 'rail'}
         role="img"
         aria-label={
           single
             ? `Egyetlen ajánlat: ${hufShort(lo)} forint.`
             : `Ársáv ${hufShort(lo)} és ${hufShort(hi)} forint között, ${valid.length} webshop ajánlatával.`
         }>
      <div className="rail-track" />

      {median !== null && median !== undefined && !single && (
        <div className="rail-median"
             style={{ left: `${Math.min(98, Math.max(2, at(median)))}%` }}
             title={`Medián: ${hufShort(median)} Ft`} />
      )}

      {valid.map((offer, index) => {
        const left = single ? 50 : at(offer.priceHuf);
        const isAnchor = anchorShopId ? offer.shopId === anchorShopId : false;
        const isLast = !single && offer.priceHuf === hi && valid.length > 2;
        return (
          <div
            key={`${offer.shopId}-${index}`}
            className="rail-tick"
            data-rank={offer.rank ?? undefined}
            data-anchor={isAnchor || undefined}
            data-stale={offer.stale || undefined}
            data-last={isLast || undefined}
            style={{
              left: `${Math.min(99.4, Math.max(0.6, left))}%`,
              animationDelay: `${Math.min(index * 45, 320)}ms`,
              ...(isAnchor || offer.rank === 1 || isLast || offer.stale
                ? {}
                : offer.shopColor ? { background: offer.shopColor } : {}),
            }}
            title={`${offer.shopName}: ${hufShort(offer.priceHuf)} Ft${
              offer.rank ? ` — ${offer.rank}. legolcsóbb` : ''
            }${offer.stale ? ' (elavult adat)' : ''}`}
          />
        );
      })}

      {showBounds && !single && (
        <div className="rail-bounds num faint">
          <span>{hufShort(lo)}</span>
          <span>{hufShort(hi)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Nagy méretű sín feliratozott megállókkal — a termék részletes oldalára.
 */
export function SpreadRailDetailed({
  offers, median, anchorShopId,
}: { offers: RailOffer[]; median?: number | null; anchorShopId?: string | null }) {
  const valid = offers.filter((o) => o.priceHuf > 0).sort((a, b) => a.priceHuf - b.priceHuf);
  if (!valid.length) {
    return (
      <div className="empty">
        <div className="display">Még nincs összehasonlítható ajánlat</div>
        <p className="muted" style={{ fontSize: 13 }}>
          A rendszer keresi ezt a termékváltozatot a többi webshopban.
        </p>
      </div>
    );
  }
  const lo = valid[0]!.priceHuf;
  const hi = valid[valid.length - 1]!.priceHuf;
  const span = Math.max(1, hi - lo);

  return (
    <div style={{ paddingBottom: 34 }}>
      <SpreadRail offers={valid} median={median} anchorShopId={anchorShopId} size="lg" showBounds={false} />
      <div style={{ position: 'relative', height: 0 }}>
        {valid.map((offer, i) => {
          const left = hi === lo ? 50 : ((offer.priceHuf - lo) / span) * 100;
          // Feliratok váltakozó sorban, hogy ne fedjék egymást
          const row = i % 2;
          return (
            <div key={offer.shopId}
                 className="rail-stop num"
                 style={{
                   left: `${Math.min(96, Math.max(4, left))}%`,
                   top: row === 0 ? -22 : -6,
                   color: offer.shopId === anchorShopId ? 'var(--wine)' : 'var(--ink-3)',
                   fontWeight: offer.shopId === anchorShopId ? 700 : 400,
                 }}>
              {hufShort(offer.priceHuf)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
