/**
 * A mar ismert listingek atugrasa a felderitesben.
 *
 * A felderites feladata UJ termek-URL-ek megtalalasa; a mar ismert termekek
 * arat a `known-listing-refresh` sor tartja naprakeszen. Az atugras NEM keres,
 * ezert nem fogyasztja a futas idokeretet - igy a `gentle` policy 0,5 keres/mp
 * uteme mellett is eljutunk a katalogus vegeig.
 *
 * A parositas szandekosan konzervativ: bizonytalansag eseten NEM ugrunk.
 */
import { describe, it, expect } from 'vitest';
import {
  KnownListingIndex, type KnownListingRow,
} from '../../apps/worker/src/lib/known-listings.js';
import type { DiscoveredTarget } from '@radovin/contracts';

const HOUR = 3600_000;
const NOW = new Date('2026-09-01T12:00:00Z').getTime();

function row(over: Partial<KnownListingRow> = {}): KnownListingRow {
  return {
    id: 'sl-1',
    platform_product_id: null,
    platform_variant_id: null,
    canonical_url: 'https://bolt.hu/termek/kekfrankos-2019',
    last_successful_extract_at: new Date(NOW - 2 * 24 * HOUR),
    ...over,
  };
}

function target(over: Partial<DiscoveredTarget> = {}): DiscoveredTarget {
  return { url: 'https://bolt.hu/termek/kekfrankos-2019', ...over };
}

/** 14 napos frissessegi ablak - ez a DISCOVERY_SKIP_FRESH_HOURS alapertelmezese. */
const index = (rows: KnownListingRow[]) => new KnownListingIndex(rows, 336 * HOUR);

describe('parositas a mar ismert listingekhez', () => {
  it('platformazonosito alapjan talal', () => {
    const idx = index([row({ platform_product_id: '12345', platform_variant_id: '7' })]);
    const hit = idx.lookup(target({ url: 'https://mas.hu/valami', platformProductId: '12345', platformVariantId: '7' }));
    expect(hit?.id).toBe('sl-1');
  });

  it('kanonikus URL alapjan talal', () => {
    expect(index([row()]).lookup(target())?.id).toBe('sl-1');
  });

  it('kisbetu es zaro perjel nem szamit', () => {
    const idx = index([row({ canonical_url: 'https://bolt.hu/Termek/Kekfrankos-2019/' })]);
    expect(idx.lookup(target())?.id).toBe('sl-1');
  });

  it('ismeretlen cel -> nincs talalat, tehat letoltjuk', () => {
    expect(index([row()]).lookup(target({ url: 'https://bolt.hu/termek/uj-bor' }))).toBeNull();
  });

  it('ket listing ugyanazon az URL-en ketertelmuseg -> az elso marad, nem irjuk felul', () => {
    const idx = index([row({ id: 'sl-1' }), row({ id: 'sl-2' })]);
    expect(idx.lookup(target())?.id).toBe('sl-1');
  });
});

describe('frissesseg', () => {
  it('az ablakon belul friss', () => {
    const idx = index([row({ last_successful_extract_at: new Date(NOW - 10 * 24 * HOUR) })]);
    expect(idx.isFresh(idx.lookup(target())!, NOW)).toBe(true);
  });

  it('az ablakon kivul mar nem friss', () => {
    const idx = index([row({ last_successful_extract_at: new Date(NOW - 20 * 24 * HOUR) })]);
    expect(idx.isFresh(idx.lookup(target())!, NOW)).toBe(false);
  });

  it('a MEG SOHA ki nem nyert listing SOHA nem ugorhato at', () => {
    // Eppen az ilyen listing szorul letoltesre: ismerjuk az URL-jet, de meg
    // egyszer sem sikerult ertelmesen kinyerni belole a terméket.
    const idx = index([row({ last_successful_extract_at: null })]);
    expect(idx.isFresh(idx.lookup(target())!, NOW)).toBe(false);
  });
});

describe('mit nyerunk vele', () => {
  it('az elso futas atsuhan az ismert 1200-on, es uj termekeket tolt le', () => {
    // Ez a deploy utani elso futas helyzete: 1200 termek mar bent van, a
    // katalogus 3000-es. Atugras nelkul a 40 perces keret (1200 keres) megint
    // ugyanarra az 1200-ra menne el.
    const BUDGET = 1200;
    const katalogus: DiscoveredTarget[] = Array.from(
      { length: 3000 }, (_, i) => ({ url: `https://bolt.hu/termek/${i}` }),
    );
    const ismert = katalogus.slice(0, 1200).map((t, i) => row({
      id: `sl-${i}`, canonical_url: t.url,
      last_successful_extract_at: new Date(NOW - 3 * 24 * HOUR),
    }));
    const idx = index(ismert);

    let atugrott = 0;
    let letoltott = 0;
    for (const t of katalogus) {
      const hit = idx.lookup(t);
      if (hit && idx.isFresh(hit, NOW)) { atugrott++; continue; }
      if (letoltott >= BUDGET) break;   // elfogyott az idokeret
      letoltott++;
    }

    expect(atugrott).toBe(1200);
    expect(letoltott).toBe(1200);
    // Atugras nelkul ez 0 lett volna: a keret elment volna az ismert reszre.
    expect(atugrott + letoltott).toBe(2400);
  });
});
