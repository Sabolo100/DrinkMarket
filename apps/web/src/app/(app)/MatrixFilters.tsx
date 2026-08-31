'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';

interface Props {
  categories: Array<{ key: string; name_hu: string }>;
  shops: Array<{ id: string; key: string; name: string }>;
  total: number;
}

/** Szerveroldali szűrés — a szűrők az URL-ben élnek, így megoszthatók. */
export function MatrixFilters({ categories, shops, total }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const set = useCallback((key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value); else next.delete(key);
    next.delete('page');
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  }, [params, pathname, router]);

  const get = (key: string) => params.get(key) ?? '';
  const activeCount = ['q', 'category', 'shopId', 'vintage', 'volumeMl', 'minShops',
    'minSpreadPct', 'onlyChanged', 'onlyReview', 'tracked']
    .filter((k) => params.get(k)).length;

  return (
    <div className="toolbar" style={{ opacity: pending ? 0.6 : 1 }}>
      <div className="grow">
        <input
          type="search"
          defaultValue={get('q')}
          placeholder="Szűrés névre, márkára, borászatra…"
          aria-label="Szűrés"
          onKeyDown={(e) => { if (e.key === 'Enter') set('q', (e.target as HTMLInputElement).value); }}
          onBlur={(e) => { if (e.target.value !== get('q')) set('q', e.target.value); }}
        />
      </div>

      <select value={get('category')} onChange={(e) => set('category', e.target.value)}
              aria-label="Kategória" style={{ width: 'auto' }}>
        <option value="">Minden kategória</option>
        {categories.map((c) => <option key={c.key} value={c.key}>{c.name_hu}</option>)}
      </select>

      <select value={get('shopId')} onChange={(e) => set('shopId', e.target.value)}
              aria-label="Csak ahol ez a webshop kínál" style={{ width: 'auto' }}>
        <option value="">Bármely webshop kínálja</option>
        {shops.map((s) => <option key={s.id} value={s.id}>Csak ahol {s.name} kínálja</option>)}
      </select>

      <select value={get('minShops')} onChange={(e) => set('minShops', e.target.value)}
              aria-label="Minimum boltszám" style={{ width: 'auto' }}>
        <option value="">Bármennyi bolt</option>
        <option value="2">Legalább 2 bolt</option>
        <option value="3">Legalább 3 bolt</option>
        <option value="5">Legalább 5 bolt</option>
      </select>

      <select value={get('minSpreadPct')} onChange={(e) => set('minSpreadPct', e.target.value)}
              aria-label="Minimum árszóródás" style={{ width: 'auto' }}>
        <option value="">Bármekkora szóródás</option>
        <option value="10">10% felett</option>
        <option value="20">20% felett</option>
        <option value="35">35% felett</option>
      </select>

      <div className="segmented">
        <button type="button" aria-pressed={get('onlyChanged') === 'true'}
                onClick={() => set('onlyChanged', get('onlyChanged') === 'true' ? '' : 'true')}>
          Csak árváltozott
        </button>
        <button type="button" aria-pressed={get('onlyReview') === 'true'}
                onClick={() => set('onlyReview', get('onlyReview') === 'true' ? '' : 'true')}>
          Csak ellenőrzendő
        </button>
        <button type="button" aria-pressed={get('tracked') === 'true'}
                onClick={() => set('tracked', get('tracked') === 'true' ? '' : 'true')}>
          Csak figyelt
        </button>
      </div>

      <div className="spacer" />
      <span className="label num">{total.toLocaleString('hu-HU')} sor</span>
      {activeCount > 0 && (
        <button className="btn btn-ghost btn-sm"
                onClick={() => startTransition(() => router.push(
                  params.get('anchorShopId')
                    ? `${pathname}?anchorShopId=${params.get('anchorShopId')}`
                    : pathname,
                ))}>
          Szűrők törlése ({activeCount})
        </button>
      )}
    </div>
  );
}
