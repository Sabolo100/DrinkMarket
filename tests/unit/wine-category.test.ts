/**
 * A bor-kategoria megvalasztasa.
 *
 * A valos rendszerben minden bizonyitott bor egyetlen, atalanyos `wine`
 * kategoriat kapott. Ez a kategoria-osszehasonlitast nem elnemitotta, hanem
 * HAMIS EGYEZESSE forditotta: a pezsgo es a szaraz voros egyarant `wine`
 * lett, tehat a mezo `match` allapotot adott rajuk - ahelyett, hogy kizarta
 * volna a part.
 *
 * A felhasznalo ezt latta: egy Sauska Brut Nature pezsgo melle a rendszer
 * Chardonnay-t, Furmintot es Syrah-t kinalt jeloltkent. Az egyetlen mezo,
 * ami ezeket egy mozdulattal kizarna, egyetértett veluk.
 */
import { describe, it, expect } from 'vitest';
import { wineCategoryFor, type WineLookups } from '../../apps/worker/src/lib/wine-apply.js';
import type { WineParseResult } from '@radovin/domain';

const STYLE_PEZSGO = 'style-pezsgo';
const STYLE_SZARAZ = 'style-szaraz';
const STYLE_ASZU = 'style-aszu';

const CAT = {
  wine: 'cat-wine',
  sparkling_wine: 'cat-sparkling',
  tokaji_aszu: 'cat-aszu',
};

const lookups: WineLookups = {
  styleColour: new Map(),
  grapeColour: new Map(),
  styleSparkling: new Map([
    [STYLE_PEZSGO, true], [STYLE_SZARAZ, false], [STYLE_ASZU, false],
  ]),
  stylePuttony: new Map([
    [STYLE_PEZSGO, false], [STYLE_SZARAZ, false], [STYLE_ASZU, true],
  ]),
  categoryIdByKey: new Map(Object.entries(CAT)),
};

function parsed(opts: {
  producer?: boolean; styleId?: string | null; grapes?: number;
}): WineParseResult {
  const slot = (id: string) => ({
    slot: 'style' as const, id, canonicalName: id, matchedText: id,
    start: 0, end: 1, viaAlias: null,
  });
  return {
    producer: opts.producer === false
      ? null
      : { slot: 'producer', id: 'p1', canonicalName: 'Sauska', matchedText: 'sauska', start: 0, end: 1, viaAlias: null },
    vineyard: null,
    region: null,
    style: opts.styleId ? slot(opts.styleId) : null,
    grapes: Array.from({ length: opts.grapes ?? 0 }, (_, i) => ({
      slot: 'grape' as const, id: `g${i}`, canonicalName: `g${i}`, matchedText: `g${i}`,
      start: 0, end: 1, viaAlias: null,
    })),
    vintageValue: null, expression: null, matches: [], ambiguous: [], tokens: [],
  } as unknown as WineParseResult;
}

describe('besorolatlan sor', () => {
  it('pezsgo bortipusbol sparkling_wine lesz, nem wine', () => {
    expect(wineCategoryFor(parsed({ styleId: STYLE_PEZSGO }), lookups, null))
      .toBe(CAT.sparkling_wine);
  });

  it('aszu bortipusbol tokaji_aszu lesz', () => {
    expect(wineCategoryFor(parsed({ styleId: STYLE_ASZU }), lookups, null))
      .toBe(CAT.tokaji_aszu);
  });

  it('szaraz bortipusbol wine', () => {
    expect(wineCategoryFor(parsed({ styleId: STYLE_SZARAZ }), lookups, null))
      .toBe(CAT.wine);
  });

  it('fajta bortipus nelkul is bor', () => {
    expect(wineCategoryFor(parsed({ grapes: 1 }), lookups, null)).toBe(CAT.wine);
  });

  it('puszta boraszat nem eleg: nem talalunk ki besorolast', () => {
    // Egy boraszatnev onmagaban lehet pohar, konyv, ajandekutalvany is.
    expect(wineCategoryFor(parsed({}), lookups, null)).toBeNull();
  });

  it('boraszat nelkul semmi', () => {
    expect(wineCategoryFor(parsed({ producer: false, grapes: 2 }), lookups, null)).toBeNull();
  });
});

describe('mar besorolt sor helyesbitese', () => {
  it('a korabban atalanyosan wine-ra allitott pezsgo JAVUL', () => {
    // Enelkul a mar eltarolt hibas besorolas orokre bennmaradna, es a
    // javitas csak az ezutan begyujtott sorokra hatna.
    expect(wineCategoryFor(parsed({ styleId: STYLE_PEZSGO }), lookups, 'wine'))
      .toBe(CAT.sparkling_wine);
  });

  it('a helyes wine besorolashoz nem nyulunk', () => {
    expect(wineCategoryFor(parsed({ styleId: STYLE_SZARAZ }), lookups, 'wine')).toBeNull();
  });

  it('a mar sparkling_wine sort nem irjuk at', () => {
    expect(wineCategoryFor(parsed({ styleId: STYLE_PEZSGO }), lookups, 'sparkling_wine'))
      .toBeNull();
  });

  it('a champagne besorolast NEM fokozzuk le sparkling_wine-ra', () => {
    // A pezsgo bortipus igaz ra, de a champagne szukebb es pontosabb.
    // Csak az atalanyos wine irhato felul.
    expect(wineCategoryFor(parsed({ styleId: STYLE_PEZSGO }), lookups, 'champagne'))
      .toBeNull();
  });

  it('tomeny kategoriahoz sosem nyulunk', () => {
    expect(wineCategoryFor(parsed({ styleId: STYLE_PEZSGO }), lookups, 'whisky')).toBeNull();
  });
});
