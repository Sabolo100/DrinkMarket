'use client';

/**
 * Import varázsló (spec 9.3).
 *
 * Lépések: 1. feltöltés → 2. oszlop-hozzárendelés → 3. ellenőrzés és előnézet
 * → 4. admin jóváhagyás → 5. véglegesítés + azonnali keresési job.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Field { key: string; label: string; required: boolean }

interface UploadResult {
  batchId: string; filename: string; totalRows: number;
  headers: string[]; suggestedMapping: Record<string, string>;
  availableFields: Field[]; sample: Array<Record<string, string>>;
}

interface ValidateResult {
  batchId: string; valid: number; warnings: number; errors: number;
  duplicates: number; total: number;
}

interface PreviewRow {
  id: string; row_number: number; status: string;
  raw: Record<string, string>;
  parsed: Record<string, unknown>;
  messages: Array<{ level: string; text: string }>;
}

export function ImportWizard({
  csrfToken, categories,
}: { csrfToken: string; categories: Array<{ key: string; name_hu: string }> }) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [defaultCategory, setDefaultCategory] = useState('');
  const [trackAll, setTrackAll] = useState(false);
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [includeWarnings, setIncludeWarnings] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);

  async function onUpload(file: File) {
    setBusy(true); setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/v1/products/import', {
        method: 'POST', headers: { 'x-csrf-token': csrfToken }, body: form,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error?.message ?? 'A feltöltés nem sikerült.'); setBusy(false); return; }
      setUpload(data);
      setMapping(data.suggestedMapping ?? {});
      setStep(2);
    } catch {
      setError('A kiszolgáló nem elérhető.');
    }
    setBusy(false);
  }

  async function onValidate() {
    if (!upload) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/v1/products/import/${upload.batchId}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ mapping, defaultCategory: defaultCategory || undefined, trackAll }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error?.message ?? 'Az ellenőrzés nem sikerült.'); setBusy(false); return; }
      setValidation(data);

      const prev = await fetch(`/api/v1/products/import/${upload.batchId}?pageSize=25`);
      if (prev.ok) {
        const p = await prev.json();
        setPreview(p.items ?? []);
      }
      setStep(3);
    } catch {
      setError('A kiszolgáló nem elérhető.');
    }
    setBusy(false);
  }

  async function onCommit() {
    if (!upload) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/v1/products/import/${upload.batchId}/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ includeWarnings, skipDuplicates: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error?.message ?? 'A véglegesítés nem sikerült.'); setBusy(false); return; }
      setResult(data);
      setStep(4);
      router.refresh();
    } catch {
      setError('A kiszolgáló nem elérhető.');
    }
    setBusy(false);
  }

  return (
    <div className="sheet">
      <div className="sheet-head">
        <div className="row-tight" style={{ gap: 14 }}>
          {[
            { n: 1, label: 'Feltöltés' },
            { n: 2, label: 'Oszlopok' },
            { n: 3, label: 'Ellenőrzés' },
            { n: 4, label: 'Véglegesítés' },
          ].map((s) => (
            <span key={s.n} className="row-tight" style={{ gap: 5, opacity: step >= s.n ? 1 : 0.4 }}>
              <span className="seal-mark" style={{
                background: step > s.n ? 'var(--verdigris-tint)' : 'var(--paper)',
                color: step > s.n ? 'var(--verdigris)' : step === s.n ? 'var(--wine)' : 'var(--ink-4)',
              }}>
                {step > s.n ? '✓' : s.n}
              </span>
              <span className="label" style={{ color: step === s.n ? 'var(--ink)' : undefined }}>
                {s.label}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div className="sheet-pad stack">
        {error && <div className="callout callout-alert" role="alert">{error}</div>}

        {/* 1. Feltöltés */}
        {step === 1 && (
          <>
            <p className="muted" style={{ fontSize: 13, maxWidth: '76ch' }}>
              Minimálisan elegendő egy <strong>terméknév</strong> vagy egy tetszőleges
              webshop <strong>termék-URL</strong>. Minden további oszlop (márka, borászat,
              kategória, kiszerelés, évjárat, EAN, ár) pontosítja az azonosítást.
            </p>
            <div className="field">
              <label className="label" htmlFor="file">CSV vagy XLSX fájl</label>
              <input id="file" type="file" accept=".csv,.xlsx,text/csv"
                     disabled={busy}
                     onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }} />
            </div>
            {busy && <p className="muted">Feltöltés és beolvasás…</p>}
          </>
        )}

        {/* 2. Oszlop-hozzárendelés */}
        {step === 2 && upload && (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{upload.filename}</strong>
                <span className="muted num" style={{ marginLeft: 8 }}>
                  {upload.totalRows.toLocaleString('hu-HU')} sor · {upload.headers.length} oszlop
                </span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
              {upload.availableFields.map((f) => (
                <div className="field" key={f.key}>
                  <label className="label" htmlFor={`map-${f.key}`}>
                    {f.label}{f.required && <span style={{ color: 'var(--rust)' }}> *</span>}
                  </label>
                  <select id={`map-${f.key}`} value={mapping[f.key] ?? ''}
                          onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}>
                    <option value="">— nincs hozzárendelve —</option>
                    {upload.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>

            <hr className="divider" />

            <div className="row" style={{ gap: 16 }}>
              <div className="field" style={{ minWidth: 220 }}>
                <label className="label" htmlFor="defcat">Alapértelmezett kategória</label>
                <select id="defcat" value={defaultCategory} onChange={(e) => setDefaultCategory(e.target.value)}>
                  <option value="">— nincs, csak a fájlból —</option>
                  {categories.map((c) => <option key={c.key} value={c.key}>{c.name_hu}</option>)}
                </select>
              </div>
              <label className="row-tight" style={{ gap: 6, fontSize: 13, alignSelf: 'flex-end', paddingBottom: 8 }}>
                <input type="checkbox" checked={trackAll} onChange={(e) => setTrackAll(e.target.checked)}
                       style={{ width: 'auto' }} />
                Minden sor kerüljön a figyelőlistára
              </label>
            </div>

            <details>
              <summary className="label" style={{ cursor: 'pointer' }}>Minta az első sorokból</summary>
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="ledger">
                  <thead>
                    <tr>{upload.headers.map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {upload.sample.map((row, i) => (
                      <tr key={i}>
                        {upload.headers.map((h) => (
                          <td key={h} style={{ fontSize: 12 }}>{row[h] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            <div className="row">
              <button className="btn" onClick={() => setStep(1)}>← Vissza</button>
              <div className="spacer" />
              <button className="btn btn-primary" onClick={onValidate}
                      disabled={busy || !mapping['name'] && !mapping['url']}>
                {busy ? 'Ellenőrzés…' : 'Ellenőrzés és előnézet →'}
              </button>
            </div>
            {!mapping['name'] && !mapping['url'] && (
              <p style={{ color: 'var(--rust)', fontSize: 12 }}>
                Legalább a terméknév vagy a termék-URL oszlopot hozzá kell rendelni.
              </p>
            )}
          </>
        )}

        {/* 3. Ellenőrzés */}
        {step === 3 && validation && (
          <>
            <div className="tally" style={{ marginBottom: 4 }}>
              <div className="tally-cell">
                <div className="label">Érvényes</div>
                <div className="figure good">{validation.valid}</div>
              </div>
              <div className="tally-cell">
                <div className="label">Figyelmeztetés</div>
                <div className="figure" style={{ color: 'var(--brass)' }}>{validation.warnings}</div>
                <div className="sub">hiányzó kötelező mező</div>
              </div>
              <div className="tally-cell">
                <div className="label">Hiba</div>
                <div className="figure alert">{validation.errors}</div>
                <div className="sub">nem importálható</div>
              </div>
              <div className="tally-cell">
                <div className="label">Duplikátum</div>
                <div className="figure">{validation.duplicates}</div>
                <div className="sub">kihagyásra kerül</div>
              </div>
            </div>

            <div className="table-wrap" style={{ maxHeight: 420 }}>
              <table className="ledger">
                <thead>
                  <tr>
                    <th className="right">Sor</th>
                    <th>Állapot</th>
                    <th>Felismert termék</th>
                    <th>Évjárat</th>
                    <th>Kiszerelés</th>
                    <th>Üzenetek</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row) => {
                    const parsed = (row.parsed ?? {}) as { name?: string; identity?: Record<string, unknown> };
                    const identity = parsed.identity ?? {};
                    return (
                      <tr key={row.id}>
                        <td className="right num">{row.row_number}</td>
                        <td>
                          <span className={`chip ${
                            row.status === 'valid' ? 'chip-verified'
                              : row.status === 'warning' ? 'chip-review'
                                : row.status === 'duplicate' ? 'chip-neutral' : 'chip-rejected'}`}
                                data-glyph={row.status === 'valid' ? '✓' : row.status === 'warning' ? '?' : '×'}>
                            {row.status === 'valid' ? 'érvényes'
                              : row.status === 'warning' ? 'figyelmeztetés'
                                : row.status === 'duplicate' ? 'duplikátum' : 'hiba'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12 }}>{parsed.name ?? '—'}</td>
                        <td className="num">{String(identity['vintageValue'] ?? '—')}</td>
                        <td className="num">
                          {identity['volumeMl'] ? `${identity['volumeMl']} ml` : '—'}
                        </td>
                        <td style={{ maxWidth: 340 }}>
                          {row.messages.slice(0, 2).map((m, i) => (
                            <div key={i} style={{
                              fontSize: 11,
                              color: m.level === 'error' ? 'var(--rust)'
                                : m.level === 'warning' ? 'var(--brass)' : 'var(--ink-3)',
                            }}>
                              {m.text}
                            </div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <label className="row-tight" style={{ gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={includeWarnings}
                     onChange={(e) => setIncludeWarnings(e.target.checked)} style={{ width: 'auto' }} />
              A figyelmeztetéssel jelölt sorok is importálódjanak (javasolt állapotban jönnek létre)
            </label>

            <div className="row">
              <button className="btn" onClick={() => setStep(2)}>← Oszlopok újra</button>
              <div className="spacer" />
              <button className="btn btn-primary" onClick={onCommit} disabled={busy}>
                {busy ? 'Véglegesítés…' : `Jóváhagyás és import (${
                  includeWarnings ? validation.valid + validation.warnings : validation.valid
                } sor)`}
              </button>
            </div>
          </>
        )}

        {/* 4. Kész */}
        {step === 4 && result && (
          <>
            <div className="callout callout-good">
              <strong>Az import lefutott.</strong> A létrejött termékváltozatokra azonnal
              elindult a keresés minden aktív webshopban.
            </div>
            <div className="tally">
              <div className="tally-cell">
                <div className="label">Termékváltozat</div>
                <div className="figure good">{result['createdVariants'] ?? 0}</div>
              </div>
              <div className="tally-cell">
                <div className="label">Termékcsalád</div>
                <div className="figure">{result['createdFamilies'] ?? 0}</div>
              </div>
              <div className="tally-cell">
                <div className="label">Figyelőlistára</div>
                <div className="figure">{result['createdTracked'] ?? 0}</div>
              </div>
              <div className="tally-cell">
                <div className="label">Keresés indult</div>
                <div className="figure">{result['searchQueued'] ?? 0}</div>
              </div>
            </div>
            <div className="row">
              <button className="btn" onClick={() => {
                setStep(1); setUpload(null); setValidation(null); setPreview([]); setResult(null);
              }}>
                Új import
              </button>
              <div className="spacer" />
              <a className="btn btn-primary" href="/termekek">Katalógus megnyitása →</a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
