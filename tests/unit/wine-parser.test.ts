import { describe, it, expect } from 'vitest';
import {
  buildWineVocabulary, parseWineName, grapeSignature,
  type VocabRow, type WineVocabulary,
} from '@radovin/domain';

/**
 * A bornev-felbontas kotelezo esetei.
 *
 * A rendszer legfontosabb igerete, hogy INKABB TARTOZKODIK, mint hogy ket
 * kulonbozo bort osszevonjon. A parser ennek az elso vedvonala: ha a
 * borászatot, a fajtat vagy az evjaratot rosszul szedi ki, minden kesobbi
 * dontes rossz alapon all.
 */

// ── Szotar-fixture. Szandekosan kicsi: az algoritmust teszteljuk, nem a
//    referenciaadat teljesseget.
const ROWS: VocabRow[] = [
  // borászatok
  { id: 'p-sauska', slot: 'producer', canonicalName: 'Sauska', phrase: 'Sauska' },
  { id: 'p-bock', slot: 'producer', canonicalName: 'Bock', phrase: 'Bock' },
  { id: 'p-gere', slot: 'producer', canonicalName: 'Gere Attila', phrase: 'Gere Attila' },
  { id: 'p-gere', slot: 'producer', canonicalName: 'Gere Attila', phrase: 'Attila Gere', viaAlias: 'Attila Gere' },

  // fajtak + szinonimak
  { id: 'g-kekfrankos', slot: 'grape', canonicalName: 'Kékfrankos', phrase: 'Kékfrankos' },
  { id: 'g-kekfrankos', slot: 'grape', canonicalName: 'Kékfrankos', phrase: 'Blaufränkisch', viaAlias: 'Blaufränkisch' },
  { id: 'g-kekfrankos', slot: 'grape', canonicalName: 'Kékfrankos', phrase: 'kék frankos', viaAlias: 'kék frankos' },
  { id: 'g-olaszrizling', slot: 'grape', canonicalName: 'Olaszrizling', phrase: 'Olaszrizling' },
  { id: 'g-olaszrizling', slot: 'grape', canonicalName: 'Olaszrizling', phrase: 'Welschriesling', viaAlias: 'Welschriesling' },
  { id: 'g-olaszrizling', slot: 'grape', canonicalName: 'Olaszrizling', phrase: 'olasz rizling', viaAlias: 'olasz rizling' },
  { id: 'g-rajnai', slot: 'grape', canonicalName: 'Rajnai rizling', phrase: 'Rajnai rizling' },
  { id: 'g-rajnai', slot: 'grape', canonicalName: 'Rajnai rizling', phrase: 'Riesling', viaAlias: 'Riesling' },
  { id: 'g-cs', slot: 'grape', canonicalName: 'Cabernet Sauvignon', phrase: 'Cabernet Sauvignon' },
  { id: 'g-cf', slot: 'grape', canonicalName: 'Cabernet Franc', phrase: 'Cabernet Franc' },
  { id: 'g-merlot', slot: 'grape', canonicalName: 'Merlot', phrase: 'Merlot' },
  { id: 'g-furmint', slot: 'grape', canonicalName: 'Furmint', phrase: 'Furmint' },
  { id: 'g-cuvee', slot: 'grape', canonicalName: 'Cuvée', phrase: 'Cuvée' },

  // bortipusok
  { id: 's-red', slot: 'style', canonicalName: 'vörös', phrase: 'vörös' },
  { id: 's-red', slot: 'style', canonicalName: 'vörös', phrase: 'vörösbor', viaAlias: 'vörösbor' },
  { id: 's-white', slot: 'style', canonicalName: 'fehér', phrase: 'fehér' },
  { id: 's-rose', slot: 'style', canonicalName: 'rosé', phrase: 'rosé' },
  { id: 's-aszu', slot: 'style', canonicalName: 'aszú', phrase: 'aszú' },

  // borvidekek (melleknevi alakkal)
  { id: 'r-tokaj', slot: 'region', canonicalName: 'Tokaj', phrase: 'Tokaj' },
  { id: 'r-tokaj', slot: 'region', canonicalName: 'Tokaj', phrase: 'Tokaji', viaAlias: 'Tokaji' },
  { id: 'r-villany', slot: 'region', canonicalName: 'Villány', phrase: 'Villány' },
  { id: 'r-villany', slot: 'region', canonicalName: 'Villány', phrase: 'Villányi', viaAlias: 'Villányi' },

  // dulo, borászathoz kotve
  { id: 'v-kopar', slot: 'vineyard', canonicalName: 'Kopár', phrase: 'Kopár', producerId: 'p-gere' },
];

const VOCAB: WineVocabulary = buildWineVocabulary(ROWS);

/** A negy azonossaghordozo slot osszehasonlithato alakban. */
function identity(name: string) {
  const r = parseWineName(name, VOCAB);
  return {
    producer: r.producer?.id ?? null,
    grapes: grapeSignature(r.grapes.map((g) => g.canonicalName)),
    style: r.style?.id ?? null,
    vintage: r.vintageValue,
    expression: r.expression,
  };
}

describe('bornev slot-felbontas', () => {
  it('a szotar felepul es minden kifejezest indexel', () => {
    expect(VOCAB.size).toBe(ROWS.length);
  });

  it('kiszedi mind a negy azonossaghordozo elemet', () => {
    const r = parseWineName('Sauska Villányi Kékfrankos 2019 0,75 l', VOCAB);
    expect(r.producer?.canonicalName).toBe('Sauska');
    expect(r.grapes.map((g) => g.canonicalName)).toEqual(['Kékfrankos']);
    expect(r.region?.canonicalName).toBe('Villány');
    expect(r.vintageValue).toBe(2019);
    // A kiszereles kulon mezo, nem szennyezi a fantazianevet
    expect(r.expression).toBeNull();
  });
});

describe('sorrendfuggetlenseg', () => {
  it('ugyanaz a bor mas sorrendben ugyanazt az identitast adja', () => {
    const a = identity('Sauska Kékfrankos 2019');
    const b = identity('2019 Sauska Kékfrankos 0,75');
    const c = identity('Kékfrankos, Sauska - 2019');
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('a borászatnev forditott alakja aliasszal is felismerheto', () => {
    expect(identity('Gere Attila Kopár 2019').producer).toBe('p-gere');
    expect(identity('Attila Gere Kopár 2019').producer).toBe('p-gere');
  });
});

describe('kizaro elteresek', () => {
  it('mas borászat mas identitas', () => {
    expect(identity('Sauska Kékfrankos 2019').producer)
      .not.toBe(identity('Bock Kékfrankos 2019').producer);
  });

  it('mas fajta mas identitas', () => {
    expect(identity('Sauska Kékfrankos 2019').grapes)
      .not.toBe(identity('Sauska Olaszrizling 2019').grapes);
  });

  it('mas evjarat mas identitas', () => {
    expect(identity('Sauska Kékfrankos 2019').vintage).toBe(2019);
    expect(identity('Sauska Kékfrankos 2020').vintage).toBe(2020);
  });

  it('mas bortipus mas identitas', () => {
    expect(identity('Sauska Cuvée vörös 2019').style).toBe('s-red');
    expect(identity('Sauska Cuvée rosé 2019').style).toBe('s-rose');
  });
});

describe('szinonimafeloldas', () => {
  it('az Olaszrizling es a Welschriesling ugyanaz a fajta', () => {
    expect(identity('Sauska Olaszrizling 2019').grapes)
      .toBe(identity('Sauska Welschriesling 2019').grapes);
  });

  it('a Kekfrankos es a Blaufrankisch ugyanaz a fajta', () => {
    expect(identity('Bock Kékfrankos 2019').grapes)
      .toBe(identity('Bock Blaufränkisch 2019').grapes);
  });

  it('a felismeres utjat megjegyzi (bizonyitekhoz)', () => {
    const r = parseWineName('Bock Blaufränkisch 2019', VOCAB);
    expect(r.grapes[0]?.viaAlias).toBe('Blaufränkisch');
    expect(r.producer?.viaAlias).toBeNull();
  });
});

describe('leghosszabb egyezes eloszor', () => {
  it('az "olasz rizling" nem esik szet "rizling"-re', () => {
    const r = parseWineName('Sauska olasz rizling 2019', VOCAB);
    expect(r.grapes.map((g) => g.canonicalName)).toEqual(['Olaszrizling']);
    expect(r.expression).toBeNull();
  });

  it('a "kek frankos" kulonirva is Kekfrankos', () => {
    expect(identity('Bock kék frankos 2019').grapes)
      .toBe(identity('Bock Kékfrankos 2019').grapes);
  });

  it('a Cabernet Sauvignon nem keverheto a Cabernet Franc-kal', () => {
    expect(identity('Bock Cabernet Sauvignon 2019').grapes).toBe('cabernet sauvignon');
    expect(identity('Bock Cabernet Franc 2019').grapes).toBe('cabernet franc');
  });
});

describe('tobb fajta (cuvee)', () => {
  it('mindegyik fajtat felismeri, es a lenyomat sorrendfuggetlen', () => {
    const a = identity('Bock Cabernet Sauvignon - Merlot 2019');
    const b = identity('Bock Merlot Cabernet Sauvignon 2019');
    expect(a.grapes).toBe(b.grapes);
    expect(a.grapes).toBe('cabernet sauvignon+merlot');
  });
});

describe('borvidek kiemelese', () => {
  it('a borvidek nem szennyezi a fantazianevet', () => {
    // Ez a konkret hiba, ami miatt a borvidek kulon slot lett: e nelkul a
    // "tokaji" a fantazianevbe kerulne, es az expression hard gate tevesen
    // elvalasztana a ket tetelt.
    const withRegion = identity('Sauska Tokaji Furmint 2021');
    const without = identity('Sauska Furmint 2021');
    expect(withRegion.expression).toBeNull();
    expect(without.expression).toBeNull();
    expect(withRegion.grapes).toBe(without.grapes);
    expect(withRegion.producer).toBe(without.producer);
  });
});

describe('fantazianev = a maradek', () => {
  it('ami egyik szotarba sem esik, az a fantazianev', () => {
    const r = parseWineName('Sauska Cuvée 7 Villányi 2019', VOCAB);
    expect(r.producer?.id).toBe('p-sauska');
    expect(r.grapes.map((g) => g.canonicalName)).toEqual(['Cuvée']);
    expect(r.region?.id).toBe('r-villany');
    // A "7" merteknek latszo token, ezert nem kerul a maradekba - a ket
    // kulonbozo Sauska cuvee-t igy a fantazianev NEM kulonbozteti meg.
    // Ezt a kockazatot a terv tudatosan vallalja: az ilyen csoport emberi
    // dontesre megy, nem kap automatikus javaslatot.
    expect(r.expression).toBeNull();
  });

  it('a valodi fantazianev megmarad', () => {
    const r = parseWineName('Gere Attila Ördög Cuvée 2019', VOCAB);
    expect(r.producer?.id).toBe('p-gere');
    expect(r.expression).toBe('ordog');
  });
});

describe('dulo borászathoz kotve', () => {
  it('a sajat borászatanal felismeri', () => {
    const r = parseWineName('Gere Attila Kopár 2019', VOCAB);
    expect(r.vineyard?.canonicalName).toBe('Kopár');
    expect(r.expression).toBeNull();
  });

  it('mas borászatnal NEM ismeri fel, a maradekban marad', () => {
    const r = parseWineName('Bock Kopár 2019', VOCAB);
    expect(r.vineyard).toBeNull();
    expect(r.expression).toBe('kopar');
  });
});

describe('ketertelműseg jelzese', () => {
  it('ket kulonbozo borászat a nevben nem hallgatolagosan dol el', () => {
    const r = parseWineName('Sauska Bock Kékfrankos 2019', VOCAB);
    expect(r.producer?.id).toBe('p-sauska');
    expect(r.ambiguous.map((a) => a.id)).toContain('p-bock');
    // A masodik borászat tokenje NEM tunik el: lathato marad a maradekban.
    expect(r.expression).toBe('bock');
  });
});

describe('grapeSignature', () => {
  it('sorrendfuggetlen es duplikatummentes', () => {
    expect(grapeSignature(['Merlot', 'Cabernet Sauvignon']))
      .toBe(grapeSignature(['Cabernet Sauvignon', 'Merlot']));
    expect(grapeSignature(['Merlot', 'Merlot'])).toBe('merlot');
  });

  it('ures halmaz -> null, hogy az ismeretlen ne mosodjon ossze az uressel', () => {
    expect(grapeSignature([])).toBeNull();
  });
});
