/**
 * A `crawl_runs.trigger` oszlop hat erteket enged. A hivok viszont beszedes
 * nevet adnak at ("review_approved", "reextract"), es az eddig egyenesen az
 * oszlopba ment.
 *
 * A kovetkezmeny lathatatlan volt: MINDEN kezi parositas-jovahagyas utan
 * elhasalt az arfrissites egy check-constraint megszegesevel, a job harom
 * probalkozas utan csendben feladta, es a felhasznalo csak annyit latott,
 * hogy nem frissul az ar.
 */
import { describe, it, expect } from 'vitest';
import { crawlTrigger } from '../../apps/worker/src/lib/crawl-trigger.js';

/** Amit az adatbazis elfogad (0005 migracio). */
const ALLOWED = ['scheduler', 'manual', 'review', 'api', 'retry', 'system'];

describe('a trigger mindig ervenyes erteket ad', () => {
  it('a valos hivok ertekei nem szegik meg a megszoritast', () => {
    const realCallers = [
      'review_approved', 'review_bulk_approved', 'review_rejected',
      'scheduler', 'manual', 'manual_url', 'discovery', 'reextract',
      'sweep', 'import', 'price_refresh', 'auto_discovery', 'canonical_fixed',
    ];
    for (const t of realCallers) {
      expect(ALLOWED).toContain(crawlTrigger(t));
    }
  });

  it('az ismeretlen es a hianyzo ertek sem tor el semmit', () => {
    for (const t of [undefined, null, '', 42, {}, 'akarmi']) {
      expect(ALLOWED).toContain(crawlTrigger(t));
    }
  });

  it('a mar ervenyes erteket valtozatlanul hagyja', () => {
    for (const t of ALLOWED) expect(crawlTrigger(t)).toBe(t);
  });
});

describe('a besorolas ertelmes marad', () => {
  it('a review-bol indulo frissites `review` marad', () => {
    expect(crawlTrigger('review_approved')).toBe('review');
    expect(crawlTrigger('review_bulk_approved')).toBe('review');
  });

  it('a kezi inditas `manual`', () => {
    expect(crawlTrigger('manual_url')).toBe('manual');
  });

  it('az ismeretlen a megadott alapertelmezest kapja', () => {
    expect(crawlTrigger('reextract', 'scheduler')).toBe('scheduler');
    expect(crawlTrigger('sweep', 'review')).toBe('review');
  });

  it('ervenytelen alapertelmezes eseten `system`', () => {
    expect(crawlTrigger('valami', 'szinten_ervenytelen')).toBe('system');
  });
});
