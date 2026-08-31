import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHead } from '@/components/Shell';
import { Seal, ShopDot, RoleTag } from '@/components/Signals';
import { ReviewActions } from './ReviewActions';
import { api, ago, dateTime, huf, requireSession, volume } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface Detail {
  reviewCase: Record<string, unknown>;
  canonical: Record<string, unknown> | null;
  verifiedListings: Array<Record<string, unknown>>;
  candidateListing: Record<string, unknown> | null;
  decision: Record<string, unknown> | null;
  candidateDetails: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  reasonLabels: Record<string, string>;
}

export default async function ReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession();

  let data: Detail;
  try {
    data = await api<Detail>(`/review-cases/${id}`);
  } catch {
    notFound();
  }

  const rc = data.reviewCase;
  const canonical = data.canonical;
  const candidate = data.candidateListing;
  const decision = data.decision;
  const fieldResults = (decision?.['field_results'] ?? {}) as Record<
    string,
    { state: string; score: number | null; role: string; leftValue?: unknown; rightValue?: unknown }
  >;
  const hardContradictions = (decision?.['hard_contradictions'] ?? []) as Array<{
    field: string; code: string; leftValue: unknown; rightValue: unknown; message: string;
  }>;
  const runnerUp = (decision?.['runner_up'] ?? []) as Array<{
    listingId: string; shopKey: string; rawName: string; url: string;
    decisionStrength: number; rejected: boolean; reasonCodes: string[];
  }>;
  const reasonCodes = (rc['reason_codes'] ?? []) as string[];

  return (
    <>
      <PageHead
        title="Párosítás elbírálása"
        lede={
          <>
            {String(rc['title'])}
            {' · '}
            <span className="muted">
              A döntés verziózott és auditált. A jóváhagyott kapcsolatot automatika
              nem írhatja felül.
            </span>
          </>
        }
        actions={<Link className="btn btn-sm" href="/parositas">← Vissza a sorhoz</Link>}
      />

      {/* Kizáró ellentmondás azonnal, a lap tetején */}
      {hardContradictions.length > 0 && (
        <div className="callout callout-alert" style={{ marginBottom: 16 }}>
          <strong>Kizáró ellentmondás — a pontszám ezt nem írhatja felül.</strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {hardContradictions.map((h, i) => (
              <li key={i} style={{ fontSize: 12, marginBottom: 3 }}>
                <strong>{fieldLabel(h.field)}:</strong> {h.message}
                {' '}
                <span className="num faint">
                  ({String(h.leftValue ?? '—')} ↔ {String(h.rightValue ?? '—')})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Pontszámsáv */}
      {decision && (
        <div className="tally" style={{ marginBottom: 18 }}>
          <ScoreCell label="Döntési erősség" value={decision['decision_strength'] as number} />
          <ScoreCell label="Mezőegyezés" value={decision['agreement_score'] as number} />
          <ScoreCell label="Bizonyíték-lefedettség" value={decision['evidence_coverage'] as number}
                     hint="A kötelező mezők hány százaléka bizonyított mindkét oldalon." />
          <ScoreCell label="Kinyerési minőség" value={decision['extraction_quality'] as number}
                     hint="A gyengébbik oldal forráskinyerésének megbízhatósága." />
          <ScoreCell label="Előny a 2. jelölthöz" value={decision['top_margin'] as number}
                     hint="Kis érték: több jelölt közel azonos erősségű." />
          <div className="tally-cell">
            <div className="label">Kizáró ellentmondás</div>
            <div className={`figure ${hardContradictions.length ? 'alert' : 'good'}`}>
              {hardContradictions.length}
            </div>
            <div className="sub">automatikus elfogadáshoz 0 kell</div>
          </div>
        </div>
      )}

      {/* Indoklás */}
      {reasonCodes.length > 0 && (
        <div className="callout" style={{ marginBottom: 18 }}>
          <strong>Miért került emberi döntésre?</strong>
          <div className="row-tight" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {reasonCodes.map((code) => (
              <span key={code} className="chip chip-review" data-glyph="?">
                {data.reasonLabels[code] ?? code}
              </span>
            ))}
          </div>
          {decision?.['explanation_hu'] ? (
            <p style={{ fontSize: 12, marginTop: 10, marginBottom: 0, color: 'var(--ink-2)' }}>
              {String(decision['explanation_hu'])}
            </p>
          ) : null}
        </div>
      )}

      {/* ── Három panel (spec 24.2) ─────────────────────────────────────── */}
      <div className="review-grid">
        {/* BAL: kanonikus változat és már igazolt listingek */}
        <div className="sheet">
          <div className="sheet-head">
            <span className="label label-strong">Kanonikus termékváltozat</span>
            {canonical && (
              <Link className="btn btn-ghost btn-sm" href={`/termek/${canonical['id']}`}>Megnyitás</Link>
            )}
          </div>
          <div className="sheet-pad">
            {canonical ? (
              <>
                <div className="display" style={{ fontSize: 17, marginBottom: 10 }}>
                  {String(canonical['canonical_display_name'])}
                </div>
                <dl className="kv">
                  <dt>Kategória</dt><dd>{String(canonical['category_name'] ?? '—')}</dd>
                  <dt>Termelő / márka</dt>
                  <dd>{String(canonical['producer_name'] ?? canonical['brand_name'] ?? '—')}</dd>
                  <dt>Tétel</dt><dd>{String(canonical['product_line'] ?? canonical['family_name'] ?? '—')}</dd>
                  <dt>Évjárat</dt>
                  <dd>{canonical['vintage_value'] ? String(canonical['vintage_value'])
                    : canonical['vintage_status'] === 'non_vintage' ? 'NV' : 'nem bizonyított'}</dd>
                  <dt>Kiszerelés</dt>
                  <dd>{volume(canonical['volume_ml'] as number, Number(canonical['pack_count'] ?? 1))}</dd>
                  <dt>Csomagolás</dt><dd>{packagingLabel(String(canonical['packaging_type']))}</dd>
                  {canonical['edition'] ? (<><dt>Kiadás</dt><dd>{String(canonical['edition'])}</dd></>) : null}
                  {canonical['gtin'] ? (<><dt>EAN</dt><dd className="num">{String(canonical['gtin'])}</dd></>) : null}
                </dl>

                <hr className="divider" />
                <div className="label" style={{ marginBottom: 8 }}>
                  Már igazolt webshopok ({data.verifiedListings.length})
                </div>
                {data.verifiedListings.length === 0 ? (
                  <p className="muted" style={{ fontSize: 12 }}>
                    Még egyetlen webshoppal sincs igazolt kapcsolata. Ez lenne az első.
                  </p>
                ) : (
                  <div className="stack-2">
                    {data.verifiedListings.map((l) => (
                      <div key={String(l['id'])} className="row-tight"
                           style={{ justifyContent: 'space-between', gap: 8,
                                    paddingBottom: 6, borderBottom: '1px solid var(--rule-faint)' }}>
                        <span className="row-tight" style={{ gap: 6, minWidth: 0 }}>
                          <ShopDot color={l['brand_color'] as string} />
                          <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis',
                                         whiteSpace: 'nowrap', maxWidth: 190 }}
                                title={String(l['raw_name'])}>
                            {String(l['raw_name'])}
                          </span>
                        </span>
                        <span className="price">{huf(l['price_huf'] as number)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="muted">Ehhez az esethez nem tartozik kanonikus termékváltozat.</p>
            )}
          </div>
        </div>

        {/* KÖZÉP: mezőnkénti összevetés */}
        <div className="sheet review-middle">
          <div className="sheet-head">
            <span className="label label-strong">Mezőnkénti bizonyítás</span>
            <span className="row-tight" style={{ gap: 8 }}>
              <Seal state="match" label="egyezik" />
              <Seal state="contradiction" label="ellentmond" />
              <Seal state="unknown" label="nem bizonyított" />
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="evidence-table">
              <thead>
                <tr>
                  <th style={{ width: '22%' }}>Mező</th>
                  <th style={{ width: '30%' }}>Kanonikus változat</th>
                  <th style={{ width: '30%' }}>Webshopjelölt</th>
                  <th style={{ width: '18%' }}>Döntés</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(fieldResults).length === 0 ? (
                  <tr><td colSpan={4} className="muted" style={{ padding: 20, textAlign: 'center' }}>
                    Nincs mezőszintű összevetés ehhez az esethez.
                  </td></tr>
                ) : (
                  Object.entries(fieldResults)
                    .sort(([, a], [, b]) => stateOrder(a.state) - stateOrder(b.state))
                    .map(([field, result]) => (
                      <tr key={field} data-state={result.state}>
                        <td>
                          <div style={{ fontWeight: 500, fontSize: 12 }}>{fieldLabel(field)}</div>
                          <RoleTag role={result.role} />
                        </td>
                        {/* A motor altal ténylegesen osszehasonlitott ertek.
                            Ha a dontes meg nem tarolta (regi rekord), a
                            rekordbol szarmaztatjuk. */}
                        <td className="num" style={{ fontSize: 12 }}>
                          {'leftValue' in result
                            ? renderCompared(result.leftValue, field)
                            : formatValue(canonical, field)}
                        </td>
                        <td className="num" style={{ fontSize: 12 }}>
                          {'rightValue' in result
                            ? renderCompared(result.rightValue, field)
                            : formatValue(candidate, field)}
                        </td>
                        <td>
                          <Seal state={result.state} />
                          {result.score !== null && (
                            <div className="cell-note num">{result.score.toFixed(2)}</div>
                          )}
                        </td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          </div>

          {runnerUp.length > 1 && (
            <div className="sheet-pad" style={{ borderTop: '1px solid var(--rule)' }}>
              <div className="label" style={{ marginBottom: 8 }}>
                További jelöltek és a pontkülönbség
              </div>
              <div className="stack-2">
                {runnerUp.slice(0, 5).map((r) => (
                  <div key={r.listingId} className="row-tight"
                       style={{ justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                    <span className="row-tight" style={{ gap: 6, minWidth: 0 }}>
                      {r.rejected
                        ? <span className="chip chip-rejected" data-glyph="×">kizárva</span>
                        : <span className="chip chip-neutral" data-glyph="·">jelölt</span>}
                      <a href={r.url} target="_blank" rel="noopener noreferrer nofollow"
                         style={{ overflow: 'hidden', textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap', maxWidth: 260 }}>
                        {r.rawName}
                      </a>
                    </span>
                    <span className="num">{r.decisionStrength.toFixed(3)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* JOBB: a webshopjelölt */}
        <div className="sheet">
          <div className="sheet-head">
            <span className="label label-strong">Webshopjelölt</span>
            {candidate && (
              <span className="row-tight" style={{ gap: 6 }}>
                <ShopDot color={candidate['brand_color'] as string} />
                <span style={{ fontSize: 12, fontWeight: 600 }}>{String(candidate['shop_name'])}</span>
              </span>
            )}
          </div>
          <div className="sheet-pad">
            {candidate ? (
              <>
                <div className="row" style={{ gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
                  {candidate['image_url'] ? (
                    <img className="thumb thumb-lg" src={String(candidate['image_url'])} alt="" loading="lazy" />
                  ) : <div className="thumb thumb-lg" aria-hidden="true" />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 500, fontSize: 14, lineHeight: 1.35 }}>
                      {String(candidate['raw_name'])}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <span className="price" style={{ fontSize: 16 }}>
                        {huf(candidate['price_huf'] as number)}
                      </span>
                      {candidate['comparable'] === false && (
                        <div className="cell-note" style={{ color: 'var(--brass)' }}>
                          Nem összehasonlítható: {String(candidate['not_comparable_reason'] ?? '')}
                        </div>
                      )}
                    </div>
                    <div className="freshness" style={{ marginTop: 4 }}>
                      megfigyelve {ago(candidate['observed_at'] as string)}
                    </div>
                  </div>
                </div>

                {/* Biztonsági megjegyzés: nincs iframe, csak saját előnézet + link */}
                <a className="btn btn-sm" href={String(candidate['canonical_url'])}
                   target="_blank" rel="noopener noreferrer nofollow"
                   style={{ width: '100%', marginBottom: 12 }}>
                  Termékoldal megnyitása új lapon ↗
                </a>

                <dl className="kv">
                  <dt>Kinyert tétel</dt><dd>{String(candidate['expression'] ?? '—')}</dd>
                  <dt>Évjárat</dt>
                  <dd>{candidate['vintage_value'] ? String(candidate['vintage_value'])
                    : candidate['vintage_status'] === 'non_vintage' ? 'NV' : 'nem bizonyított'}</dd>
                  <dt>Kiszerelés</dt>
                  <dd>{volume(candidate['volume_ml'] as number, Number(candidate['pack_count'] ?? 1))}</dd>
                  <dt>Csomagolás</dt><dd>{packagingLabel(String(candidate['packaging_type']))}</dd>
                  {candidate['abv_percent'] ? (<><dt>Alkohol</dt><dd>{String(candidate['abv_percent'])}%</dd></>) : null}
                  {candidate['gtin'] ? (<><dt>EAN</dt><dd className="num">{String(candidate['gtin'])}</dd></>) : null}
                  <dt>Kinyerési minőség</dt>
                  <dd className="num">{Number(candidate['extraction_quality'] ?? 0).toFixed(2)}</dd>
                  <dt>Készlet</dt>
                  <dd>{candidate['in_stock'] === true ? 'készleten'
                    : candidate['in_stock'] === false ? 'elfogyott' : 'ismeretlen'}</dd>
                </dl>

                <EvidenceList evidence={(candidate['evidence'] ?? {}) as Record<string, {
                  raw_value?: string; method?: string; source_location?: string; confidence?: number;
                }>} />
              </>
            ) : (
              <p className="muted">Ehhez az esethez nincs kiválasztott webshopjelölt.</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Műveletek ───────────────────────────────────────────────────── */}
      <div style={{ marginTop: 20 }}>
        <ReviewActions
          caseId={id}
          rowVersion={Number(rc['row_version'] ?? 1)}
          csrfToken={session.csrfToken}
          canApprove={['reviewer', 'catalog_manager', 'source_manager', 'admin'].includes(session.user.role)}
          canEditCanonical={['catalog_manager', 'admin'].includes(session.user.role)}
          candidates={data.candidateDetails.map((c) => ({
            id: String(c['id']),
            name: String(c['raw_name']),
            shopName: String(c['shop_name']),
            price: c['price_huf'] as number | null,
            url: String(c['canonical_url']),
          }))}
          currentListingId={rc['source_listing_id'] as string | null}
        />
      </div>

      {/* ── Audit idővonal ──────────────────────────────────────────────── */}
      {data.events.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2 className="display" style={{ fontSize: 17, marginBottom: 8 }}>Eset előzményei</h2>
          <div className="sheet sheet-pad">
            <div className="stack-2">
              {data.events.map((e) => (
                <div key={String(e['id'])} className="row-tight"
                     style={{ gap: 10, paddingBottom: 6, borderBottom: '1px solid var(--rule-faint)' }}>
                  <span className="freshness" style={{ minWidth: 120 }}>
                    {dateTime(e['occurred_at'] as string)}
                  </span>
                  <span className="chip chip-neutral" data-glyph="·">{String(e['action'])}</span>
                  <span style={{ fontSize: 12 }}>{String(e['note'] ?? '')}</span>
                  <div className="spacer" />
                  <span className="faint" style={{ fontSize: 11 }}>{String(e['actor_name'] ?? 'rendszer')}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

// ── Segédek ─────────────────────────────────────────────────────────────────

function ScoreCell({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  const v = value === null || value === undefined ? null : Number(value);
  return (
    <div className="tally-cell" title={hint}>
      <div className="label">{label}</div>
      <div className="figure" style={{ fontSize: 21 }}>
        {v === null ? '—' : v.toFixed(3)}
      </div>
      {hint && <div className="sub" style={{ maxWidth: 200 }}>{hint}</div>}
    </div>
  );
}

function EvidenceList({ evidence }: {
  evidence: Record<string, { raw_value?: string; method?: string; source_location?: string; confidence?: number }>;
}) {
  const entries = Object.entries(evidence).filter(([, e]) => e?.raw_value);
  if (!entries.length) return null;
  return (
    <>
      <hr className="divider" />
      <div className="label" style={{ marginBottom: 6 }}>Kinyerési bizonyítékok</div>
      <div className="stack-2">
        {entries.slice(0, 10).map(([field, e]) => (
          <div key={field}>
            <div style={{ fontSize: 11, color: 'var(--ink-2)' }}>
              {fieldLabel(field)}
              <span className="faint"> · {e.method} · {((e.confidence ?? 0) * 100).toFixed(0)}%</span>
            </div>
            <div className="evidence-note" title={e.source_location}>„{e.raw_value}”</div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * A motor altal osszehasonlitott nyers ertek megjelenitese. Ha a mezo egyik
 * oldalon sem volt bizonyitott, azt EGYERTELMUEN kimondjuk - nem helyettesitjuk
 * mas oszlopbol szarmazo, a dontesben fel nem hasznalt ertekkel.
 */
function renderCompared(value: unknown, field: string): string {
  if (value === null || value === undefined || value === '' || value === 'unknown') {
    return 'nem bizonyított';
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'nem bizonyított';
  if (field === 'volumeMl') return volume(Number(value));
  if (field === 'packagingType') return packagingLabel(String(value));
  if (field === 'vintage' && value === 'non_vintage') return 'NV (évjárat nélküli)';
  return String(value);
}

function stateOrder(state: string): number {
  return state === 'contradiction' ? 0 : state === 'unknown' ? 1 : state === 'match' ? 2 : 3;
}

function formatValue(source: Record<string, unknown> | null, field: string): string {
  if (!source) return '—';
  const map: Record<string, string[]> = {
    producer: ['producer_name', 'raw_brand'],
    brand: ['brand_name', 'raw_brand'],
    expression: ['expression', 'product_line', 'family_name'],
    vintage: ['vintage_value'],
    vintageValue: ['vintage_value'],
    ageStatementYears: ['age_statement_years'],
    volumeMl: ['volume_ml'],
    packCount: ['pack_count'],
    packagingType: ['packaging_type'],
    edition: ['edition'],
    caskFinish: ['cask_finish'],
    dosageStyle: ['dosage_style'],
    puttony: ['puttony'],
    abvPercent: ['abv_percent'],
    gtin: ['gtin', 'gtin_normalized'],
    categoryKey: ['category_key'],
    colour: ['colour'],
    region: ['region'],
    countryCode: ['country_code', 'origin_country'],
    grapeVarieties: ['grape_varieties'],
  };
  for (const key of map[field] ?? [field]) {
    const value = source[key];
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
    if (field === 'volumeMl') return volume(Number(value));
    if (field === 'packagingType') return packagingLabel(String(value));
    return String(value);
  }
  // Külön kezelt: NV státusz
  if ((field === 'vintage' || field === 'vintageValue') && source['vintage_status'] === 'non_vintage') {
    return 'NV (évjárat nélküli)';
  }
  return 'nem bizonyított';
}

function packagingLabel(type: string): string {
  const map: Record<string, string> = {
    standard: 'normál palack', gift_box: 'díszdoboz', wooden_case: 'fadoboz',
    carton: 'karton', tube: 'tubus', set: 'szett', tin: 'fémdoboz', unknown: 'nem bizonyított',
  };
  return map[type] ?? type;
}

function fieldLabel(field: string): string {
  const map: Record<string, string> = {
    producer: 'Termelő', brand: 'Márka', expression: 'Tétel / expression',
    vintage: 'Évjárat', vintageValue: 'Évjárat', ageStatementYears: 'Korjelölés',
    volumeMl: 'Kiszerelés', packCount: 'Darabszám', packagingType: 'Csomagolás',
    edition: 'Kiadás', caskFinish: 'Hordóérlelés', dosageStyle: 'Dosage',
    puttony: 'Puttonyszám', abvPercent: 'Alkoholtartalom', gtin: 'EAN / GTIN',
    categoryKey: 'Kategória', colour: 'Szín', region: 'Régió',
    countryCode: 'Ország', grapeVarieties: 'Szőlőfajta', sweetness: 'Édesség',
    fruit: 'Gyümölcs', flavour: 'Ízesítés', aging: 'Érlelés',
    negative_alias: 'Kizárt névpár',
  };
  return map[field] ?? field;
}
