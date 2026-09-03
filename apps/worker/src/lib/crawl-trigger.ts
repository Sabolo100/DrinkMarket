/**
 * A `crawl_runs.trigger` oszlop ertekei szigoruan korlatozottak
 * (`scheduler | manual | review | api | retry | system`), a hivok viszont
 * beszedes nevet adnanak at a jobban ("review_approved", "reextract", ...).
 *
 * Eddig a hivo szovege egyenesen az oszlopba ment. Emiatt MINDEN kezi
 * parositas-jovahagyas utan elhasalt az arfrissites egy
 * `crawl_runs_trigger_check` megszegesevel - lathatatlanul, mert a job
 * csendben ujraprobalkozott, majd feladta.
 *
 * A javitas iranya szandekos: nem a hivokat kotjuk meg, hanem itt fordítunk.
 * Igy egy uj hivo sem tudja elrontani, es a beszedes nev megmarad a job
 * payloadjaban a naplo szamara.
 */
const ALLOWED = new Set(['scheduler', 'manual', 'review', 'api', 'retry', 'system']);

export function crawlTrigger(raw: unknown, fallback = 'system'): string {
  const v = typeof raw === 'string' ? raw : '';
  if (ALLOWED.has(v)) return v;
  // A beszedes nevek besorolasa. Ami nem ismerheto fel, az `system`.
  if (v.startsWith('review')) return 'review';
  if (v.startsWith('manual') || v === 'manual_url') return 'manual';
  if (v.startsWith('schedul')) return 'scheduler';
  if (v.startsWith('retry')) return 'retry';
  if (v.startsWith('api') || v.startsWith('import')) return 'api';
  return ALLOWED.has(fallback) ? fallback : 'system';
}
