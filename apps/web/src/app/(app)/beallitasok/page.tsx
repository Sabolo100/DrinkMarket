import { PageHead } from '@/components/Shell';
import { FlagToggle } from '@/components/Actions';
import { apiSafe, dateTime, num, pct, requireSession } from '@/lib/api';

export const dynamic = 'force-dynamic';

const FLAG_META: Record<string, { label: string; help: string }> = {
  auto_match: {
    label: 'Automatikus párosítás',
    help: 'Ha ki van kapcsolva, minden új párosítás emberi jóváhagyásra vár. A pilot alatt szándékosan kikapcsolt: a széles automatikus elfogadás csak mért és dokumentált pontosság után engedélyezhető.',
  },
  auto_match_identifier_only: {
    label: 'Automatikus párosítás csak erős azonosítóval',
    help: 'Bekapcsolva az automatika kizárólag exact platformazonosító vagy EAN + minden kötelező mező egyezése esetén fogad el párt.',
  },
  embeddings: {
    label: 'Embedding-alapú jelöltkeresés',
    help: 'Opcionális visszakeresési réteg ritka elnevezési változatokhoz. Soha nem dönthet önállóan termékazonosságról.',
  },
  browser_crawler: {
    label: 'Böngészős crawler',
    help: 'Playwright-alapú renderelés azoknál a forrásoknál, ahol nincs stabil HTTP/JSON út. Külön, alacsony konkurencián futó workerben dolgozik.',
  },
  ai_extraction: {
    label: 'AI-alapú mezőkinyerés',
    help: 'Csak bizonyítékkötött módon: minden AI-mezőhöz eredeti szövegrészlet és forráshely tartozik, egyébként az érték „nem bizonyított” marad.',
  },
  external_websearch: {
    label: 'Külső kereső API',
    help: 'site: lekérdezés elrejtett termék-URL felderítésére. A találati kivonat nem árforrás és nem azonossági bizonyíték.',
  },
  auto_publish: {
    label: 'Automatikus piaci publikáció',
    help: 'Sikeres minőségi kapu után az új összehasonlítási pillanatkép automatikusan élesedik. Kikapcsolva minden generáció karanténban marad.',
  },
};

export default async function SettingsPage() {
  const session = await requireSession();
  const isAdmin = session.user.role === 'admin';

  const [settings, metrics, golden] = await Promise.all([
    apiSafe<{
      items: Array<{ key: string; version: number; value: unknown; description: string | null; requires_approval: boolean; approved_at: string | null }>;
      flags: Array<{ key: string; enabled: boolean; description: string | null; updated_at: string }>;
      criticalKeys: string[];
    }>('/settings', { items: [], flags: [], criticalKeys: [] }),
    apiSafe<{
      matching: Record<string, number> | null;
      crawling: Record<string, number> | null;
      business: Record<string, number> | null;
      policy: Record<string, unknown>;
    }>('/metrics/summary', { matching: null, crawling: null, business: null, policy: {} }),
    apiSafe<{
      items: Array<Record<string, unknown>>;
      datasetCounts: Array<{ label: string; count: number }>;
    }>('/golden/evaluations', { items: [], datasetCounts: [] }),
  ]);

  const m = metrics.matching ?? {};
  const cr = metrics.crawling ?? {};
  const goldenCounts = new Map(golden.datasetCounts.map((g) => [g.label, g.count]));
  const lastEval = golden.items[0];

  return (
    <>
      <PageHead
        title="Beállítások"
        lede={
          <>Minden változás verziózott és auditált. A kritikus párosítási policy
          módosításához adminisztrátori jogosultság ÉS friss, sikeres golden kiértékelés
          szükséges — érzés alapján küszöb nem véglegesíthető.</>
        }
      />

      {/* ── Feature flagek ──────────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>Funkciókapcsolók</h2>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10, maxWidth: '80ch' }}>
          A kritikus automatizálás mindig kapcsolóval védett. Ha egy szabály téves
          párosítást okoz, azonnal kikapcsolható anélkül, hogy a rendszer leállna.
        </p>
        <div className="sheet sheet-pad">
          {settings.flags.map((flag) => {
            const meta = FLAG_META[flag.key] ?? { label: flag.key, help: flag.description ?? '' };
            return (
              <FlagToggle key={flag.key} flagKey={flag.key} enabled={flag.enabled}
                          csrfToken={session.csrfToken} label={meta.label} help={meta.help}
                          canEdit={isAdmin} />
            );
          })}
          {!isAdmin && (
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              A kapcsolók módosításához adminisztrátori szerepkör szükséges.
            </p>
          )}
        </div>
      </section>

      {/* ── Párosítási mérőszámok ───────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>Párosítási mérőszámok</h2>
        <div className="tally">
          <Cell label="Igazolt kapcsolat" value={num(m['verified_total'] ?? 0)} tone="good" />
          <Cell label="Automatikus" value={num(m['auto_verified'] ?? 0)}
                sub={`${num(m['human_verified'] ?? 0)} emberi`} />
          <Cell label="Nyitott ellenőrzés" value={num(m['review_open'] ?? 0)}
                tone={(m['review_open'] ?? 0) > 0 ? 'alert' : undefined} />
          <Cell label="Elfogadva / elutasítva"
                value={`${num(m['review_approved'] ?? 0)} / ${num(m['review_rejected'] ?? 0)}`} />
          <Cell label="Több egyforma jelölt" value={num(m['ambiguous'] ?? 0)} />
          <Cell label="Nem bizonyítható" value={num(m['insufficient'] ?? 0)} />
          <Cell label="Identitás-eltolódás" value={num(m['drifted'] ?? 0)}
                tone={(m['drifted'] ?? 0) > 0 ? 'alert' : undefined} />
          <Cell label="Átlagos top margin"
                value={m['avg_top_margin'] !== null && m['avg_top_margin'] !== undefined
                  ? Number(m['avg_top_margin']).toFixed(3) : '—'}
                sub="30 napos átlag" />
        </div>
      </section>

      {/* ── Crawler mérőszámok ──────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>Crawler mérőszámok · 7 nap</h2>
        <div className="tally">
          <Cell label="Futás" value={num(cr['runs_7d'] ?? 0)}
                sub={`${num(cr['runs_succeeded_7d'] ?? 0)} sikeres`} />
          <Cell label="Karanténba került" value={num(cr['runs_quarantined_7d'] ?? 0)}
                tone={(cr['runs_quarantined_7d'] ?? 0) > 0 ? 'alert' : undefined} />
          <Cell label="HTTP kérés" value={num(cr['requests_7d'] ?? 0)} />
          <Cell label="Sebességkorlát" value={num(cr['rate_limits_7d'] ?? 0)} />
          <Cell label="Kinyerési siker"
                value={cr['extraction_success_rate'] !== null && cr['extraction_success_rate'] !== undefined
                  ? pct(Number(cr['extraction_success_rate']) * 100) : '—'} />
        </div>
      </section>

      {/* ── Golden dataset ──────────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <h2 className="display" style={{ fontSize: 18, marginBottom: 4 }}>Golden dataset és kalibráció</h2>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10, maxWidth: '80ch' }}>
          A párosítás nem javítható, ha nem mérjük külön a jelöltkeresés hibáját a döntési
          hibától. A küszöbök csak mért, dokumentált eredmény alapján módosíthatók.
        </p>
        <div className="row" style={{ gap: 16, alignItems: 'stretch' }}>
          <div className="sheet sheet-pad" style={{ flex: '1 1 300px' }}>
            <div className="label" style={{ marginBottom: 10 }}>Címkézett tesztkészlet</div>
            <dl className="kv">
              <dt>Pozitív pár</dt>
              <dd className="num">
                {num(goldenCounts.get('positive') ?? 0)}
                <span className="faint"> / cél 300</span>
              </dd>
              <dt>Nehéz negatív</dt>
              <dd className="num">
                {num(goldenCounts.get('hard_negative') ?? 0)}
                <span className="faint"> / cél 300</span>
              </dd>
              <dt>Igazolt „nincs”</dt>
              <dd className="num">
                {num(goldenCounts.get('no_match') ?? 0)}
                <span className="faint"> / cél 100</span>
              </dd>
            </dl>
            <div className="callout" style={{ marginTop: 12, fontSize: 12 }}>
              A tesztkészlet fejlesztése az első feladat, nem a crawler írása. Minden
              történelmi hiba regressziós teszté alakítandó.
            </div>
          </div>

          <div className="sheet sheet-pad" style={{ flex: '1 1 340px' }}>
            <div className="label" style={{ marginBottom: 10 }}>Legutóbbi kiértékelés</div>
            {lastEval ? (
              <dl className="kv">
                <dt>Futás ideje</dt><dd>{dateTime(lastEval['run_at'] as string)}</dd>
                <dt>Matcher verzió</dt><dd className="num">{String(lastEval['matcher_version'])}</dd>
                <dt>Auto precision</dt>
                <dd className="num">
                  {lastEval['precision_auto'] !== null
                    ? pct(Number(lastEval['precision_auto']) * 100) : '—'}
                  {lastEval['precision_ci_low'] !== null && (
                    <span className="faint">
                      {' '}(95% CI: {pct(Number(lastEval['precision_ci_low']) * 100)}–
                      {pct(Number(lastEval['precision_ci_high']) * 100)})
                    </span>
                  )}
                </dd>
                <dt>candidate_recall@10</dt>
                <dd className="num">
                  {lastEval['candidate_recall_10'] !== null
                    ? pct(Number(lastEval['candidate_recall_10']) * 100) : '—'}
                  <span className="faint"> / cél 98%</span>
                </dd>
                <dt>Hard negative</dt>
                <dd className="num">
                  {lastEval['hard_negative_pass'] !== null
                    ? pct(Number(lastEval['hard_negative_pass']) * 100) : '—'}
                  <span className="faint"> / cél 100%</span>
                </dd>
                <dt>False positive</dt>
                <dd className="num" style={{ color: Number(lastEval['false_positives']) > 0 ? 'var(--rust)' : 'var(--verdigris)' }}>
                  {String(lastEval['false_positives'] ?? 0)}
                  <span className="faint"> / tolerancia 0</span>
                </dd>
                <dt>Eredmény</dt>
                <dd>
                  {lastEval['passed']
                    ? <span className="chip chip-verified" data-glyph="✓">megfelelt</span>
                    : <span className="chip chip-rejected" data-glyph="×">nem felelt meg</span>}
                </dd>
              </dl>
            ) : (
              <p className="muted" style={{ fontSize: 13 }}>
                Még nem futott golden kiértékelés. Parancs:{' '}
                <code className="num" style={{ fontSize: 11 }}>npm run golden</code>
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── Verziózott beállítások ──────────────────────────────────────── */}
      <section>
        <h2 className="display" style={{ fontSize: 18, marginBottom: 8 }}>Verziózott beállítások</h2>
        <div className="table-wrap">
          <table className="ledger">
            <thead>
              <tr>
                <th>Kulcs</th>
                <th className="right">Verzió</th>
                <th>Érték</th>
                <th>Leírás</th>
                <th>Jóváhagyás</th>
              </tr>
            </thead>
            <tbody>
              {settings.items.map((s) => (
                <tr key={s.key}>
                  <td className="num" style={{ fontSize: 12, fontWeight: 600 }}>
                    {s.key}
                    {settings.criticalKeys.includes(s.key) && (
                      <span className="chip chip-rejected" data-glyph="!" style={{ marginLeft: 6 }}>
                        kritikus
                      </span>
                    )}
                  </td>
                  <td className="right num">v{s.version}</td>
                  <td>
                    <pre className="evidence-note" style={{ margin: 0, whiteSpace: 'pre-wrap',
                                                            maxWidth: 420, maxHeight: 120, overflow: 'auto' }}>
                      {JSON.stringify(s.value, null, 1)}
                    </pre>
                  </td>
                  <td className="muted" style={{ fontSize: 11, maxWidth: 300 }}>{s.description ?? '—'}</td>
                  <td className="freshness">
                    {s.requires_approval
                      ? (s.approved_at ? dateTime(s.approved_at) : 'jóváhagyásra vár')
                      : 'nem igényel'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Cell({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'good' | 'alert';
}) {
  return (
    <div className="tally-cell">
      <div className="label">{label}</div>
      <div className={`figure ${tone ?? ''}`} style={{ fontSize: 21 }}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
