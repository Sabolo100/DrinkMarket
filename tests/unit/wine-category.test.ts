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
const STYLE_ROSE_LIKE = 'style-rose';

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
    [STYLE_ROSE_LIKE, false],
  ]),
  stylePuttony: new Map([
    [STYLE_PEZSGO, false], [STYLE_SZARAZ, false], [STYLE_ASZU, true],
    [STYLE_ROSE_LIKE, false],
  ]),
  categoryIdByKey: new Map(Object.entries(CAT)),
};

function parsed(opts: {
  producer?: boolean;
  /** A NYERTES stilus-slot. */
  styleId?: string | null;
  /** Az egyertekű slotrol LESZORULT tovabbi stilusok. */
  ambiguousStyles?: string[];
  grapes?: number;
  tokens?: string[];
}): WineParseResult {
  const slot = (id: string) => ({
    slot: 'style' as const, id, canonicalName: id, matchedText: id,
    startToken: 0, tokenCount: 1, viaAlias: null,
  });
  const grapes = Array.from({ length: opts.grapes ?? 0 }, (_, i) => ({
    slot: 'grape' as const, id: `g${i}`, canonicalName: `g${i}`, matchedText: `g${i}`,
    startToken: 0, tokenCount: 1, viaAlias: null,
  }));
  const style = opts.styleId ? slot(opts.styleId) : null;
  const ambiguous = (opts.ambiguousStyles ?? []).map(slot);
  return {
    producer: opts.producer === false
      ? null
      : { slot: 'producer', id: 'p1', canonicalName: 'Sauska', matchedText: 'sauska', startToken: 0, tokenCount: 1, viaAlias: null },
    vineyard: null,
    region: null,
    style,
    grapes,
    vintageValue: null, expression: null,
    // A parser a hozzarendelt talalatokat a `matches`-be is beteszi.
    matches: [...(style ? [style] : []), ...grapes],
    ambiguous,
    tokens: opts.tokens ?? [],
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

  it('a FAJTA onmagaban bizonyitja a bort, boraszat nelkul is', () => {
    // A felhasznalo szabalya: ha a nevben barhol van szolofajta, az biztos
    // bor - meg ha a "bor" szo nincs is benne. Enelkul a besorolas csak a
    // jovahagyott boraszatu sorokra jutott volna el, azaz a katalogus
    // toredekere.
    expect(wineCategoryFor(parsed({ producer: false, grapes: 2 }), lookups, null))
      .toBe(CAT.wine);
  });

  it('a bortipus onmagaban is eleg', () => {
    expect(wineCategoryFor(parsed({ producer: false, styleId: STYLE_SZARAZ }), lookups, null))
      .toBe(CAT.wine);
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

// ═══════════════════════════════════════════════════════════════════════════
// A pezsgo FELULIR mindent
//
// A parser egyertekű slotokat tolt, es a stilus-slotot a nevben ELOL allo
// talalat nyeri. A "Sauska Rose Brut pezsgo" nevben a `rose` all elol, tehat
// AZ nyer - a `brut` es a `pezsgo` az `ambiguous` listaba kerul.
//
// Aki csak a nyertes slotot nezi, abbol CSENDES ROSE-t csinal. A felhasznalo
// szabalya viszont egyertelmu: ha a nevben BARHOL ott van, hogy pezsgo, az
// pezsgo - meg akkor is, ha mellette rose vagy Chardonnay all.
// ═══════════════════════════════════════════════════════════════════════════
describe('a pezsgo felulir minden mas stilust', () => {
  it('rose nyerte a slotot, de a pezsgo ott van a nevben -> sparkling_wine', () => {
    expect(wineCategoryFor(
      parsed({ styleId: STYLE_ROSE_LIKE, ambiguousStyles: [STYLE_PEZSGO] }), lookups, null,
    )).toBe(CAT.sparkling_wine);
  });

  it('pezsgo szolofajta mellett is pezsgo marad', () => {
    expect(wineCategoryFor(
      parsed({ styleId: STYLE_ROSE_LIKE, ambiguousStyles: [STYLE_PEZSGO], grapes: 1 }),
      lookups, null,
    )).toBe(CAT.sparkling_wine);
  });

  it('a korabban wine-ra allitott rose pezsgo JAVUL', () => {
    expect(wineCategoryFor(
      parsed({ styleId: STYLE_ROSE_LIKE, ambiguousStyles: [STYLE_PEZSGO] }), lookups, 'wine',
    )).toBe(CAT.sparkling_wine);
  });

  it('pezsgo nelkul a rose csendes bor marad', () => {
    expect(wineCategoryFor(parsed({ styleId: STYLE_ROSE_LIKE }), lookups, null))
      .toBe(CAT.wine);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ami NEM bor
//
// A fajta onmagaban bizonyitja a bort - de egy "Kadarka palinka" nevben is
// ott a Kadarka. A tomeny nem kaphat bor-besorolast.
// ═══════════════════════════════════════════════════════════════════════════
describe('a tomeny nem bor, meg fajtaval sem', () => {
  it('Kadarka palinka -> nincs bor-besorolas', () => {
    expect(wineCategoryFor(
      parsed({ grapes: 1, tokens: ['kadarka', 'palinka'] }), lookups, null,
    )).toBeNull();
  });

  it('whisky -> nincs bor-besorolas', () => {
    expect(wineCategoryFor(
      parsed({ grapes: 1, tokens: ['single', 'malt', 'whisky'] }), lookups, null,
    )).toBeNull();
  });

  it('a bor-nevet nem zavarja a szures', () => {
    expect(wineCategoryFor(
      parsed({ grapes: 1, tokens: ['sauska', 'kekfrankos', '2019'] }), lookups, null,
    )).toBe(CAT.wine);
  });
});
