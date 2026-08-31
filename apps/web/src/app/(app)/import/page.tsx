import Link from 'next/link';
import { PageHead } from '@/components/Shell';
import { ImportWizard } from './ImportWizard';
import { apiSafe, dateTime, num, requireSession } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const session = await requireSession();
  const canImport = ['catalog_manager', 'admin'].includes(session.user.role);

  const [batches, categories] = await Promise.all([
    apiSafe<{ items: Array<Record<string, unknown>>; total: number }>(
      '/products/imports', { items: [], total: 0 }),
    apiSafe<{ items: Array<{ key: string; name_hu: string }> }>('/categories', { items: [] }),
  ]);

  return (
    <>
      <PageHead
        title="Import"
        lede={
          <>CSV vagy XLSX terméklista feltöltése. A varázsló felismeri az oszlopokat,
          kinyeri az attribútumokat bizonyítékkal, jelzi a hiányzó kötelező mezőket és a
          duplikátumokat — a véglegesítés csak jóváhagyás után történik.</>
        }
      />

      {canImport ? (
        <ImportWizard csrfToken={session.csrfToken} categories={categories.items} />
      ) : (
        <div className="callout">
          Az importhoz <strong>katalóguskezelő</strong> szerepkör szükséges.
        </div>
      )}

      <section style={{ marginTop: 28 }}>
        <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>Korábbi importok</h2>
        {batches.items.length === 0 ? (
          <div className="empty">
            <div className="display">Még nem volt import</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Fájl</th>
                  <th>Állapot</th>
                  <th className="right">Sorok</th>
                  <th className="right">Érvényes</th>
                  <th className="right">Figyelmeztetés</th>
                  <th className="right">Hiba</th>
                  <th className="right">Duplikátum</th>
                  <th className="right">Létrejött</th>
                  <th>Feltöltő</th>
                  <th>Idő</th>
                </tr>
              </thead>
              <tbody>
                {batches.items.map((b) => (
                  <tr key={String(b['id'])}>
                    <td>
                      <Link href={`/import/${b['id']}`} style={{ color: 'var(--ink)', fontWeight: 500 }}>
                        {String(b['filename'] ?? 'import')}
                      </Link>
                      <div className="cell-note">{String(b['source_kind'])}</div>
                    </td>
                    <td><BatchStatus status={String(b['status'])} /></td>
                    <td className="right num">{num(Number(b['total_rows'] ?? 0))}</td>
                    <td className="right num" style={{ color: 'var(--verdigris)' }}>{num(Number(b['valid_rows'] ?? 0))}</td>
                    <td className="right num" style={{ color: 'var(--brass)' }}>{num(Number(b['warning_rows'] ?? 0))}</td>
                    <td className="right num" style={{ color: 'var(--rust)' }}>{num(Number(b['error_rows'] ?? 0))}</td>
                    <td className="right num">{num(Number(b['duplicate_rows'] ?? 0))}</td>
                    <td className="right num">
                      {num(Number(b['created_variants'] ?? 0))}
                      <div className="cell-note">{num(Number(b['created_tracked'] ?? 0))} figyelt</div>
                    </td>
                    <td style={{ fontSize: 12 }}>{String(b['uploaded_by_name'] ?? '—')}</td>
                    <td className="freshness">{dateTime(b['created_at'] as string)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function BatchStatus({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: string; glyph: string }> = {
    uploaded:   { label: 'feltöltve', tone: 'chip-neutral', glyph: '↑' },
    mapping:    { label: 'oszlop-hozzárendelés', tone: 'chip-neutral', glyph: '≡' },
    validating: { label: 'ellenőrzés fut', tone: 'chip-neutral', glyph: '◌' },
    validated:  { label: 'ellenőrizve', tone: 'chip-review', glyph: '?' },
    committing: { label: 'véglegesítés fut', tone: 'chip-neutral', glyph: '◌' },
    committed:  { label: 'véglegesítve', tone: 'chip-verified', glyph: '✓' },
    failed:     { label: 'hibás', tone: 'chip-rejected', glyph: '×' },
    cancelled:  { label: 'visszavonva', tone: 'chip-neutral', glyph: '‖' },
  };
  const s = map[status] ?? { label: status, tone: 'chip-neutral', glyph: '·' };
  return <span className={`chip ${s.tone}`} data-glyph={s.glyph}>{s.label}</span>;
}
