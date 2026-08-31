'use client';

/**
 * Kiinduló webshop választó (spec 22.3, V2.1).
 *
 * A választás CSAK felületi szűrő és összehasonlítási nézőpont:
 *  · nem módosítja a párosításokat,
 *  · nem indít új kanonikus rekordot,
 *  · nem befolyásolja a matching score-t.
 * Csak a megjelenített termékkört, a rögzített oszlopot és az árkülönbségek
 * viszonyítási pontját változtatja.
 *
 * A RADOVIN ugyanabban a listában, azonos státusszal szerepel, mint a többi.
 */
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';

export interface AnchorShop {
  id: string;
  key: string;
  name: string;
  brand_color?: string | null;
  health_status?: string;
  active?: boolean;
}

export function AnchorShopPicker({ shops }: { shops: AnchorShop[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get('anchorShopId') ?? '';
  const [pending, setPending] = useState(false);

  const onChange = useCallback((value: string) => {
    setPending(true);
    const next = new URLSearchParams(params.toString());
    if (value) next.set('anchorShopId', value);
    else next.delete('anchorShopId');
    next.delete('page');
    router.push(`${pathname}?${next.toString()}`);
    router.refresh();
    setTimeout(() => setPending(false), 400);
  }, [params, pathname, router]);

  const selected = shops.find((s) => s.id === current);

  return (
    <div className="anchor-picker" data-active={current ? 'true' : undefined}
         title="A kiinduló webshop csak nézőpont: nem módosítja a párosításokat és a pontszámokat.">
      <span className="label" style={{ fontSize: 9 }}>Kiinduló</span>
      {selected && (
        <span className="shop-dot" style={{ background: selected.brand_color || 'var(--cork)' }} />
      )}
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        aria-label="Kiinduló webshop kiválasztása"
        style={{ minWidth: 150 }}
      >
        <option value="">Nincs kiemelt webshop</option>
        {shops.map((shop) => (
          <option key={shop.id} value={shop.id}>
            {shop.name}{shop.active === false ? ' (inaktív)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
