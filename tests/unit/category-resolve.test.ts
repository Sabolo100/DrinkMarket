/**
 * Kategoria-feloldas morzsautbol es nevbol.
 *
 * A reszszo-keres korabban az ELSO talalatot adta vissza, a Map beszurasi
 * sorrendjeben. Ez nem semleges sorrend: a seedben a `wine` aliaszai
 * (koztuk a `rose`) ELOBB allnak, mint a `sparkling_wine` aliaszai - egy
 * "Rose pezsgo" szovegbol ezert BOR lett.
 *
 * A hiba sulyat az adta, hogy a kategoria kozben kemeny kizaro jelle valt:
 * a rossz besorolas mar nem csak pontot von, hanem nemán kizar - vagy eppen
 * hamis egyezest ad ket kulonbozo termekre.
 */
import { describe, it, expect } from 'vitest';
import { Taxonomy } from '@radovin/domain';

/** A seed SORRENDJE szamit: a `wine` aliaszai allnak elol, ahogy elesben is. */
const CATEGORIES = [
  { id: 'c-wine', key: 'wine' },
  { id: 'c-sparkling', key: 'sparkling_wine' },
  { id: 'c-champagne', key: 'champagne' },
  { id: 'c-aszu', key: 'tokaji_aszu' },
  { id: 'c-whisky', key: 'whisky' },
  { id: 'c-other', key: 'other_spirit' },
];

const ALIASES: Array<[string, string]> = [
  ['wine', 'bor'], ['wine', 'borok'], ['wine', 'vörösbor'], ['wine', 'fehérbor'],
  ['wine', 'rosé'], ['wine', 'rozé'], ['wine', 'száraz bor'],
  ['sparkling_wine', 'pezsgő'], ['sparkling_wine', 'habzóbor'],
  ['sparkling_wine', 'pezsgő és habzóbor'],
  ['champagne', 'champagne'], ['champagne', 'pezsgő champagne'],
  ['tokaji_aszu', 'aszú'], ['tokaji_aszu', 'tokaji aszú'],
  ['whisky', 'whisky'], ['whisky', 'single malt'],
  ['other_spirit', 'tömény'],
];

function taxonomy(): Taxonomy {
  return new Taxonomy({
    brands: [], producers: [], aliases: [], negativeAliases: [], identityTerms: [],
    version: '1.0.0',
    categories: CATEGORIES.map((c) => ({
      ...c,
      nameNorm: c.key,
      aliases: ALIASES.filter(([k]) => k === c.key).map(([, a]) => a),
    })) as never,
  });
}

const t = taxonomy();
const key = (s: string) => t.resolveCategory(s)?.key ?? null;

describe('a magasabb rendu tipus felulir', () => {
  it('"Rosé pezsgő" -> pezsgo, nem bor', () => {
    // Ez a regresszio: a `rose` alias elobb all a listaban.
    expect(key('Rosé pezsgő')).toBe('sparkling_wine');
  });

  it('"Borok / Rosé / Pezsgő" morzsaut -> pezsgo', () => {
    expect(key('Borok Rosé Pezsgő')).toBe('sparkling_wine');
  });

  it('"Fehérbor pezsgő" -> pezsgo', () => {
    expect(key('Fehérbor pezsgő')).toBe('sparkling_wine');
  });

  it('"Tokaji aszú édes bor" -> aszu', () => {
    expect(key('Tokaji aszú édes bor')).toBe('tokaji_aszu');
  });

  it('a champagne szukebb, azt adja vissza', () => {
    expect(key('Pezsgő champagne')).toBe('champagne');
  });
});

describe('felulirás nelkul a leghosszabb alias nyer', () => {
  it('"Száraz bor" a hosszabb, nem a puszta "bor"', () => {
    expect(key('Száraz bor')).toBe('wine');
  });

  it('"Single malt whisky" -> whisky', () => {
    expect(key('Single malt whisky')).toBe('whisky');
  });
});

describe('a szabalyos eseteket nem rontja el', () => {
  it('pontos egyezes', () => {
    expect(key('bor')).toBe('wine');
    expect(key('pezsgő')).toBe('sparkling_wine');
  });

  it('ekezet nelkul is', () => {
    expect(key('pezsgo')).toBe('sparkling_wine');
  });

  it('ismeretlen szoveg -> null, nem talalunk ki semmit', () => {
    expect(key('Ajándékutalvány')).toBeNull();
    expect(key('')).toBeNull();
  });

  it('a szo BELSEJEBEN allo alias nem szamit', () => {
    // A "borotva" nem bor. A hatarellenorzesnek meg kell maradnia.
    expect(key('borotva')).toBeNull();
  });
});
