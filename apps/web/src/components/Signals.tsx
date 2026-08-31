/**
 * Állapotjelölés: SOHA nem csak szín — ikon és szöveg is kíséri (spec 22.2).
 * A frontend nem moshatja össze a státuszokat egyetlen „nincs adat” felirattal
 * (spec 20.3).
 */
import { huf, pct, ago } from '@/lib/format';

// ── Párosítási státusz ──────────────────────────────────────────────────────

const MATCH_STATUS: Record<string, { label: string; tone: string; glyph: string; help: string }> = {
  unsearched:                  { label: 'Még nem keresve', tone: 'chip-neutral', glyph: '·', help: 'Még nem futott érvényes keresés ebben a webshopban.' },
  searching:                   { label: 'Keresés folyik', tone: 'chip-neutral', glyph: '◌', help: 'A keresési munkafolyamat éppen fut.' },
  candidate_found:             { label: 'Van jelölt', tone: 'chip-review', glyph: '?', help: 'Legalább egy jelölt akadt, de a döntés még nem született meg.' },
  needs_review:                { label: 'Ellenőrzés kell', tone: 'chip-review', glyph: '?', help: 'Nincs kizáró ellentmondás, de hiányzik valamely kötelező bizonyíték.' },
  ambiguous:                   { label: 'Több egyforma jelölt', tone: 'chip-review', glyph: '≈', help: 'Két vagy több jelölt gyakorlatilag azonos erősségű.' },
  insufficient_evidence:       { label: 'Nem bizonyítható', tone: 'chip-review', glyph: '∅', help: 'A legjobb jelölt sem éri el a felülvizsgálati küszöböt.' },
  auto_verified:               { label: 'Automatikusan igazolt', tone: 'chip-verified', glyph: '✓', help: 'Minden kötelező mező bizonyítottan egyezik, ellentmondás nélkül.' },
  human_verified:              { label: 'Ember igazolta', tone: 'chip-verified', glyph: '✓', help: 'Reviewer hagyta jóvá. Automatika nem írhatja felül.' },
  rejected:                    { label: 'Elutasítva', tone: 'chip-rejected', glyph: '×', help: 'Kizáró ellentmondás vagy kézi elutasítás.' },
  not_found_after_full_search: { label: 'Teljes keresés: nincs', tone: 'chip-neutral', glyph: '—', help: 'Egészséges forrás mellett a teljes keresési terv sem hozott elfogadható jelöltet.' },
  source_unhealthy:            { label: 'Forráshiba', tone: 'chip-technical', glyph: '!', help: 'Technikai állapot miatt nem vonható le üzleti következtetés — ez NEM „nincs ilyen termék”.' },
  search_incomplete:           { label: 'Keresés hiányos', tone: 'chip-technical', glyph: '!', help: 'A keresés nem futott le teljesen.' },
  mapping_drift:               { label: 'Identitás-eltolódás', tone: 'chip-rejected', glyph: '⇄', help: 'A korábban párosított listing identitása megváltozott. Az ár nem publikálódik.' },
  listing_missing:             { label: 'Listing eltűnt', tone: 'chip-technical', glyph: '⌀', help: 'A termékoldal átmenetileg vagy tartósan eltűnt.' },
  suspended:                   { label: 'Felfüggesztve', tone: 'chip-neutral', glyph: '‖', help: 'Admin által felfüggesztett kapcsolat.' },
};

export function MatchStatusChip({ status, compact }: { status: string; compact?: boolean }) {
  const s = MATCH_STATUS[status] ?? { label: status, tone: 'chip-neutral', glyph: '·', help: status };
  return (
    <span className={`chip ${s.tone}`} data-glyph={s.glyph} title={s.help}>
      {compact ? '' : s.label}
    </span>
  );
}

export function matchStatusLabel(status: string): string {
  return MATCH_STATUS[status]?.label ?? status;
}

// ── Forrás egészsége ────────────────────────────────────────────────────────

const HEALTH: Record<string, { label: string; tone: string; glyph: string }> = {
  ok:       { label: 'Egészséges', tone: 'chip-verified', glyph: '✓' },
  degraded: { label: 'Romló', tone: 'chip-review', glyph: '~' },
  failing:  { label: 'Hibás', tone: 'chip-rejected', glyph: '×' },
  blocked:  { label: 'Blokkolt', tone: 'chip-rejected', glyph: '⊘' },
  disabled: { label: 'Kikapcsolva', tone: 'chip-neutral', glyph: '‖' },
  unknown:  { label: 'Ismeretlen', tone: 'chip-neutral', glyph: '·' },
};

export function HealthChip({ status }: { status: string }) {
  const h = HEALTH[status] ?? HEALTH['unknown']!;
  return <span className={`chip ${h.tone}`} data-glyph={h.glyph}>{h.label}</span>;
}

// ── Bizonyíték-pecsét ───────────────────────────────────────────────────────

const SEAL: Record<string, { cls: string; glyph: string; label: string }> = {
  match:         { cls: 'seal-match', glyph: '✓', label: 'Bizonyítottan egyezik' },
  contradiction: { cls: 'seal-contradiction', glyph: '×', label: 'Kizáró ellentmondás' },
  unknown:       { cls: 'seal-unknown', glyph: '?', label: 'Nem bizonyított' },
  not_applicable:{ cls: 'seal-na', glyph: '–', label: 'Nem értelmezett' },
};

export function Seal({ state, label }: { state: string; label?: string }) {
  const s = SEAL[state] ?? SEAL['unknown']!;
  return (
    <span className={`seal ${s.cls}`} title={s.label}>
      <span className="seal-mark" aria-hidden="true">{s.glyph}</span>
      <span>{label ?? s.label}</span>
    </span>
  );
}

const ROLE_LABEL: Record<string, string> = {
  required: 'Kötelező',
  contradiction_only: 'Kizáró',
  supporting: 'Támogató',
  not_applicable: 'Nem értelmezett',
};

export function RoleTag({ role }: { role: string }) {
  return (
    <span className="label" style={{ fontSize: 9, letterSpacing: '0.1em' }}>
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

// ── Ár és frissesség ────────────────────────────────────────────────────────

interface PriceProps {
  value: number | null | undefined;
  rank?: number | null;
  denominator?: number | null;
  stale?: boolean;
  onSale?: boolean;
  regular?: number | null;
  observedAt?: string | null;
  href?: string | null;
  note?: string | null;
}

export function PriceCell({
  value, rank, denominator, stale, onSale, regular, observedAt, href, note,
}: PriceProps) {
  if (value === null || value === undefined) {
    return (
      <div>
        <span className="price price-none">—</span>
        {note && <div className="cell-note">{note}</div>}
      </div>
    );
  }
  const cls = stale ? 'price price-stale'
    : rank === 1 ? 'price price-lead'
      : denominator && rank === denominator && denominator > 2 ? 'price price-high'
        : 'price';

  const inner = (
    <>
      <span className={cls}>{huf(value)}</span>
      {onSale && regular && regular > value && (
        <span className="delta delta-down" style={{ marginLeft: 6 }}>
          <s className="faint">{huf(regular)}</s>
        </span>
      )}
    </>
  );

  return (
    <div>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow"
           title="Termékoldal megnyitása új lapon">{inner}</a>
      ) : inner}
      <div className="row-tight" style={{ gap: 6, marginTop: 2 }}>
        {rank && denominator ? (
          <span className="freshness">{rank}/{denominator}.</span>
        ) : null}
        {observedAt && (
          <span className="freshness" data-stale={stale || undefined}
                title={stale ? 'Az adat a frissességi határon kívül van, ezért nem számít a rangsorba.' : undefined}>
            {ago(observedAt)}{stale ? ' · elavult' : ''}
          </span>
        )}
      </div>
      {note && <div className="cell-note">{note}</div>}
    </div>
  );
}

export function DeltaBadge({ value, invert }: { value: number | null | undefined; invert?: boolean }) {
  if (value === null || value === undefined) return <span className="delta delta-flat">—</span>;
  if (Math.abs(value) < 0.05) return <span className="delta delta-flat">0%</span>;
  const positive = value > 0;
  const good = invert ? positive : !positive;
  return (
    <span className={`delta ${good ? 'delta-down' : 'delta-up'}`}>
      {positive ? '▲' : '▼'} {pct(value)}
    </span>
  );
}

export function ShopDot({ color, name }: { color?: string | null; name?: string }) {
  return (
    <span className="shop-dot"
          style={{ background: color || 'var(--cork)' }}
          title={name} aria-hidden="true" />
  );
}

export function DataQualityChip({ quality }: { quality: string }) {
  const map: Record<string, { label: string; tone: string; glyph: string; help: string }> = {
    ok:          { label: 'Teljes', tone: 'chip-verified', glyph: '✓', help: 'Minden ajánlat friss és igazolt.' },
    partial:     { label: 'Részleges', tone: 'chip-review', glyph: '~', help: 'Legalább egy forrás adata elavult.' },
    provisional: { label: 'Ideiglenes', tone: 'chip-review', glyph: '1', help: 'Csak egyetlen webshopban van ajánlat — nincs valódi összehasonlítás.' },
    degraded:    { label: 'Hiányos', tone: 'chip-technical', glyph: '!', help: 'Forráshiány miatt az összehasonlítás nem teljes.' },
  };
  const q = map[quality] ?? map['degraded']!;
  return <span className={`chip ${q.tone}`} data-glyph={q.glyph} title={q.help}>{q.label}</span>;
}
