import Link from 'next/link';
import { num } from '@/lib/api';

/**
 * Lapozó — a jelenlegi szűrőket MEGTARTVA.
 *
 * Négy oldal (Párosítások, Nem talált, Árváltozások, Auditnapló) megkapta az
 * API-tól a lapozási adatot, de nem rajzolt lapozót: mindig csak az első oldal
 * látszott, a többi sor egyszerűen elérhetetlen volt. 1 665 nyitott esetből
 * így 50-et lehetett megnyitni.
 *
 * A Terméktár lapozója pedig csak a boltot vitte tovább, a többi szűrőt
 * eldobta — a második oldalra lépve más lista jött, mint amit szűrtél.
 *
 * Ezért EGY komponens: minden oldal ugyanúgy lapoz, és a szűrőket soha nem
 * veszíti el.
 */
export function Pager({
  basePath, sp, page, pageSize, total, hasMore,
}: {
  basePath: string;
  sp: Record<string, string | string[] | undefined>;
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}) {
  if (page <= 1 && !hasMore) return null;

  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k !== 'page' && typeof v === 'string' && v) qs.set(k, v);
    }
    if (p > 1) qs.set('page', String(p));
    const s = qs.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="pagination">
      <span className="muted num">
        {from}–{to} / {num(total)}
        <span style={{ marginLeft: 10 }}>· {page}. oldal / {num(pages)}</span>
      </span>
      <div className="spacer" />
      {page > 2 && <Link className="btn btn-sm btn-ghost" href={href(1)}>« Első</Link>}
      {page > 1 && <Link className="btn btn-sm" href={href(page - 1)}>← Előző</Link>}
      {hasMore && <Link className="btn btn-sm" href={href(page + 1)}>Következő →</Link>}
      {hasMore && page < pages - 1 && (
        <Link className="btn btn-sm btn-ghost" href={href(pages)}>Utolsó »</Link>
      )}
    </div>
  );
}
