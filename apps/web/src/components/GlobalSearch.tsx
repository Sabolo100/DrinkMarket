'use client';

/**
 * Globális termékkereső (spec 22.3).
 *
 * Keres kanonikus neveken, EREDETI webshopneveken, márkán, termelőn,
 * évjáraton, kiszerelésen, EAN-on és SKU-n. Egy webshop-listing kiválasztásakor
 * a rendszer automatikusan annak kanonikus termékváltozatára navigál; ha még
 * nincs klaszterezve, a keresés folyamatát és a jelölteket mutatja.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { hufShort, volume } from '@/lib/format';

interface Result {
  query: string;
  parsed: { vintage: number | null; volumeMl: number | null; digits: string | null };
  identifierHits: Array<Record<string, unknown>>;
  variants: Array<Record<string, unknown>>;
  listings: Array<Record<string, unknown>>;
  brands: Array<Record<string, unknown>>;
  producers: Array<Record<string, unknown>>;
  total: number;
}

export function GlobalSearch() {
  const router = useRouter();
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd + K a keresőre ugrik
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    if (term.trim().length < 2) { setResult(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/v1/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (res.ok) { setResult(await res.json()); setOpen(true); }
      } catch { /* megszakítva */ }
      finally { setLoading(false); }
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term]);

  /** Listing kiválasztása: a rendszer a kanonikus változatra navigál. */
  async function openListing(id: string) {
    setOpen(false);
    const res = await fetch(`/api/v1/search/resolve-listing/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.canonicalVariantId) router.push(`/termek/${data.canonicalVariantId}`);
    else if (data.openReviewId) router.push(`/parositas/${data.openReviewId}`);
    else router.push(`/termektar?listing=${id}`);
  }

  return (
    <div className="omni" ref={boxRef}>
      <input
        ref={inputRef}
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => result && setOpen(true)}
        placeholder="Termék, márka, borászat, évjárat, EAN vagy webshopnév…  (Ctrl+K)"
        aria-label="Globális termékkereső"
        autoComplete="off"
      />

      {open && result && (
        <div className="omni-results" role="listbox">
          {result.parsed.vintage || result.parsed.volumeMl || result.parsed.digits ? (
            <div className="omni-section">
              <div className="label">Felismert szűrők</div>
              <div className="row-tight" style={{ padding: '2px 12px 6px', gap: 6 }}>
                {result.parsed.vintage && <span className="chip chip-neutral" data-glyph="⌾">{result.parsed.vintage}</span>}
                {result.parsed.volumeMl && <span className="chip chip-neutral" data-glyph="◍">{volume(result.parsed.volumeMl)}</span>}
                {result.parsed.digits && <span className="chip chip-wine" data-glyph="#">EAN {result.parsed.digits}</span>}
              </div>
            </div>
          ) : null}

          {result.identifierHits.length > 0 && (
            <Section title="Pontos azonosító-találat">
              {result.identifierHits.map((hit) => (
                <button key={String(hit['id'])} className="omni-row"
                        onClick={() => openListing(String(hit['id']))}>
                  <span className="chip chip-verified" data-glyph="#">EAN</span>
                  <span>{String(hit['title'])}</span>
                  <span className="meta">{String(hit['shop_name'])}</span>
                </button>
              ))}
            </Section>
          )}

          {result.variants.length > 0 && (
            <Section title="Kanonikus termékváltozatok">
              {result.variants.map((v) => (
                <button key={String(v['id'])} className="omni-row"
                        onClick={() => { setOpen(false); router.push(`/termek/${v['id']}`); }}>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontWeight: 500 }}>{String(v['title'])}</span>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {[v['category_name'], v['producer_name'] ?? v['brand_name'],
                        v['vintage_value'], v['volume_ml'] ? volume(Number(v['volume_ml'])) : null]
                        .filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="meta num">
                    {v['shop_count'] ? `${v['shop_count']} bolt` : 'nincs ajánlat'}
                    {v['min_price_huf'] ? ` · ${hufShort(Number(v['min_price_huf']))} Ft-tól` : ''}
                  </span>
                </button>
              ))}
            </Section>
          )}

          {result.listings.length > 0 && (
            <Section title="Webshopok eredeti terméknevei">
              {result.listings.map((l) => (
                <button key={String(l['id'])} className="omni-row"
                        onClick={() => openListing(String(l['id']))}>
                  <span className="shop-dot" style={{ background: String(l['brand_color'] ?? 'var(--cork)') }} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block' }}>{String(l['title'])}</span>
                    <span className="faint" style={{ fontSize: 11 }}>
                      {String(l['shop_name'])}
                      {l['cluster_status'] !== 'clustered' ? ' · még nincs klaszterezve' : ''}
                    </span>
                  </span>
                  <span className="meta num">
                    {l['price_huf'] ? `${hufShort(Number(l['price_huf']))} Ft` : ''}
                  </span>
                </button>
              ))}
            </Section>
          )}

          {(result.brands.length > 0 || result.producers.length > 0) && (
            <Section title="Márkák és termelők">
              {[...result.producers, ...result.brands].map((b) => (
                <button key={`${b['kind']}-${b['id']}`} className="omni-row"
                        onClick={() => { setOpen(false); router.push(`/termekek?q=${encodeURIComponent(String(b['title']))}`); }}>
                  <span className="label">{b['kind'] === 'brand' ? 'Márka' : 'Termelő'}</span>
                  <span>{String(b['title'])}</span>
                  <span className="meta num">{String(b['family_count'] ?? 0)} tétel</span>
                </button>
              ))}
            </Section>
          )}

          {result.total === 0 && !loading && (
            <div style={{ padding: '18px 14px', textAlign: 'center' }} className="muted">
              Nincs találat erre: <strong>{result.query}</strong>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="omni-section">
      <div className="label">{title}</div>
      {children}
    </div>
  );
}
