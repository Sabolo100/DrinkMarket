/**
 * Formázók. Szándékosan kliensbiztos modul: nem importál `next/headers`-t,
 * ezért kliens- és szerverkomponensben egyaránt használható.
 */
// ── Formázók ────────────────────────────────────────────────────────────────

const HUF = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 });
const PCT = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 1, signDisplay: 'exceptZero' });

export function huf(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${HUF.format(value)} Ft`;
}

export function hufShort(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return HUF.format(value);
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${PCT.format(value)}%`;
}

export function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return HUF.format(value);
}

/** Relatív idő magyarul, a tényleges frissesség jelzésére (spec 18.1). */
export function ago(value: string | Date | null | undefined): string {
  if (!value) return 'soha';
  const date = typeof value === 'string' ? new Date(value) : value;
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 1) return 'most';
  if (minutes < 60) return `${minutes} perce`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} órája`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} napja`;
  const months = Math.round(days / 30);
  if (months < 13) return `${months} hónapja`;
  return `${Math.round(months / 12)} éve`;
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function dateOnly(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Kiszerelés emberi formában: 750 -> „0,75 l”. */
export function volume(ml: number | null | undefined, packCount = 1): string {
  if (!ml) return '—';
  const unit = ml >= 1000
    ? `${(ml / 1000).toLocaleString('hu-HU', { maximumFractionDigits: 2 })} l`
    : `${ml} ml`;
  return packCount > 1 ? `${packCount} × ${unit}` : unit;
}
