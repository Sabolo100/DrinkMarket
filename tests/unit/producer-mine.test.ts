/**
 * Boraszat-jeloltek banyaszasa.
 *
 * Az elso valos meres tanulsaga rogzitve: a puszta szogyakorisag
 * hasznalhatatlan volt. A 20208 listing rangsoranak tetejen ezek alltak:
 *
 *   eves 841 · chateau 475 · cask 371 · gin 295 · the 276 · whisky 2239
 *
 * Egyetlen boraszat sem. Ezek a tesztek azt bizonyitjak, hogy a harom
 * javitas - termelonev-jelolok, pozicio, boltok kozti tamogatottsag -
 * kiemeli a valodi neveket a zajbol.
 */
import { describe, it, expect } from 'vitest';
import {
  mineProducerCandidates, looksLikeHungarianPersonName, type MineInput,
} from '@radovin/domain';

/** Egy listing maradeka a slot-kitoltes utan. */
function listing(shopKey: string, rawName: string, residue: string): MineInput {
  return { shopKey, rawName, residueTokens: residue.split(' ').filter(Boolean) };
}

/** Ugyanaz a maradek N boltbol, hogy atmenjen a tamogatottsagi kuszobon. */
function inShops(residue: string, shops: string[], rawName = residue): MineInput[] {
  return shops.map((s) => listing(s, rawName, residue));
}

function names(cands: ReturnType<typeof mineProducerCandidates>): string[] {
  return cands.map((c) => c.name);
}

describe('termelonev-jelolok', () => {
  it('a Château a nev RESZE, nem zaj', () => {
    // Ez forditotta meg a korabbi kovetkeztetest: a 'chateau' 475
    // elofordulassal a zajlista tetejen allt, holott a "Château Margaux"
    // maga a pinceszet neve.
    const inputs = [
      ...inShops('chateau margaux', ['a', 'a', 'a']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    expect(names(out)).toContain('chateau margaux');
    expect(out.find((c) => c.name === 'chateau margaux')?.hasMarker).toBe(true);
  });

  it('a jelolos nev EGYETLEN boltbol is jelolt', () => {
    // Egy kulfoldi birtok gyakran kizarolagos egy boltnal - a jelolo
    // onmagaban eleg bizonyitek, nem varunk tobbboltos tamogatast.
    const inputs = [
      listing('a', 'Domaine Leflaive Puligny 2019', 'domaine leflaive puligny'),
      listing('a', 'Domaine Leflaive Bourgogne 2020', 'domaine leflaive bourgogne'),
      listing('a', 'Domaine Leflaive Macon 2021', 'domaine leflaive macon'),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    expect(names(out)).toContain('domaine leflaive');
  });

  it('a magyar jelolo UTOTAG, es a nev resze', () => {
    const inputs = [
      ...inShops('jasdi pince', ['a', 'b']),
      ...inShops('gilvesy pinceszet', ['a', 'b']),
      ...inShops('takler borbirtok', ['a', 'b']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).toEqual(expect.arrayContaining([
      'jasdi pince', 'gilvesy pinceszet', 'takler borbirtok',
    ]));
  });
});

describe('a zaj kiszurese', () => {
  it('a tomeny- es kereskedelmi szokincs nem lehet jelolt', () => {
    // Pontosan azok a tokenek, amik a valos meresben a lista elejet vittek.
    const zaj = ['whisky', 'cask', 'single', 'reserve', 'eves', 'the', 'premium', 'gin'];
    const inputs = zaj.flatMap((z) => inShops(`${z} valami`, ['a', 'b', 'c']));
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    for (const z of zaj) {
      expect(names(out).some((n) => n.startsWith(z))).toBe(false);
    }
  });

  it('szammal kezdodo vagy szamot tartalmazo jelolt nincs', () => {
    const inputs = [
      ...inShops('12 eves valami', ['a', 'b', 'c']),
      ...inShops('1942 kulonleges', ['a', 'b', 'c']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    expect(out.every((c) => !/\d/.test(c.name))).toBe(true);
  });
});

describe('boltok kozti tamogatottsag', () => {
  it('az egyboltos, jelolo nelkuli nev kimarad', () => {
    const inputs = inShops('valamilyen fantazianev', ['csak-egy-bolt', 'csak-egy-bolt', 'csak-egy-bolt']);
    const out = mineProducerCandidates(inputs, { minCount: 3, minShops: 2 });
    expect(out).toHaveLength(0);
  });

  it('a tobbboltos nev bekerul, es elorebb rangsorolodik', () => {
    const inputs = [
      ...inShops('sauska', ['a', 'b', 'c', 'd']),
      ...inShops('kevesbe ismert', ['a', 'b']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    const sauska = out.findIndex((c) => c.name === 'sauska');
    const masik = out.findIndex((c) => c.name === 'kevesbe ismert');
    expect(sauska).toBeGreaterThanOrEqual(0);
    expect(sauska).toBeLessThan(masik);
  });
});

describe('magyar szemelynev-felismeres', () => {
  it('a Vezeteknev Keresztnev mintat felismeri', () => {
    expect(looksLikeHungarianPersonName('Gere Attila')).toBe(true);
    expect(looksLikeHungarianPersonName('Bolyki János')).toBe(true);
    expect(looksLikeHungarianPersonName('Szepsy István')).toBe(true);
    expect(looksLikeHungarianPersonName('Bott Frigyes')).toBe(true);
  });

  it('a nem szemelynevet nem jeloli meg', () => {
    expect(looksLikeHungarianPersonName('Sauska')).toBe(false);
    expect(looksLikeHungarianPersonName('Chateau Margaux')).toBe(false);
    expect(looksLikeHungarianPersonName('Takler Borbirtok')).toBe(false);
  });

  it('a szemelynev-jelzes megjelenik a jelolten', () => {
    // Ez nem kozmetika: a szemelynev-alapu pinceszeteknel a fuzzy egyezes
    // TILOS (spec 13.3) - a "Gere Attila" es a "Gere Zsolt" ket kulon
    // boraszat, a trigram-hasonlosaguk viszont magas.
    const out = mineProducerCandidates(inShops('gere attila', ['a', 'b']), { minCount: 2, minShops: 2 });
    expect(out.find((c) => c.name === 'gere attila')?.personName).toBe(true);
  });
});

describe('bizonyitek a jovahagyashoz', () => {
  it('minden jelolt visz peldat a nyers nevekbol', () => {
    const inputs = [
      listing('a', 'Sauska Kékfrankos 2019', 'sauska'),
      listing('b', 'SAUSKA Furmint 2021', 'sauska'),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(out[0]?.examples.length).toBeGreaterThan(0);
    expect(out[0]?.examples[0]).toContain('Sauska');
  });
});

describe('a valos meres szemetje - regresszio', () => {
  it('a puszta jelolo nem jelolt', () => {
    // A `chateau` 415 elofordulassal, 5 bolttal a rangsor elejen allt.
    // Onmagaban semmit nem azonosit: minden francia birtok neveben ott van.
    const inputs = [
      ...inShops('chateau margaux', ['a', 'b']),
      ...inShops('chateau latour', ['a', 'b']),
      ...inShops('chateau palmer', ['a', 'b']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).not.toContain('chateau');
    expect(names(out)).toContain('chateau margaux');
  });

  it('kotoszora vegzodo nevtoredek nem jelolt', () => {
    // A "chateau de" 42 elofordulassal kerult a rangsor elejere, mert MINDEN
    // "Château de X" bor beleszamolt. Nevtoredek, nem boraszat.
    const inputs = [
      ...inShops('chateau de sales', ['a', 'b']),
      ...inShops('chateau de beru', ['a', 'b']),
      ...inShops('domaine de montille', ['a', 'b']),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).not.toContain('chateau de');
    expect(names(out)).not.toContain('domaine de');
    expect(names(out)).toEqual(expect.arrayContaining(['chateau de sales', 'domaine de montille']));
  });

  it('kotoszoval kezdodo nevtoredek sem jelolt', () => {
    // A "Disznóko Szolobirtok ES Pinceszet" nevbol az utotag-ablak
    // "es pinceszet"-et vagott ki - ertelmetlen toredek.
    const inputs = inShops('disznoko szolobirtok es pinceszet', ['a', 'b']);
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).not.toContain('es pinceszet');
  });

  it('a hosszabb jelolos alak megmarad, ha a rovidebb kotoszora vegzodne', () => {
    // "Chateau Cos d'Estournel": a 3-gram "chateau cos d" kotoszora vegzodik,
    // ezert kell a 4 tokenes ablak.
    const inputs = inShops('chateau cos d estournel', ['a', 'b']);
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).toContain('chateau cos d estournel');
    expect(names(out)).not.toContain('chateau cos d');
  });
});

describe('atfedo nevvaltozatok feloldasa', () => {
  /** N listing ugyanabbol a maradekbol, adott boltokban. */
  function n(times: number, residue: string, shops: string[], rawName: string): MineInput[] {
    return Array.from({ length: times }, (_, i) =>
      listing(shops[i % shops.length]!, rawName, residue));
  }

  it('azonos darabszamnal a ROVIDEBB felesleges', () => {
    // A `moet` 58 elofordulassal szerepelt, a `moet chandon` szinten 58-cal:
    // a rovid MINDIG a hosszu reszekent fordult elo, tehat onmagaban semmit
    // nem azonosit.
    const inputs = n(8, 'moet chandon', ['a', 'b'], 'Moët & Chandon');
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).toContain('moet chandon');
    expect(names(out)).not.toContain('moet');
  });

  it('a ritkabb hosszabb valtozatot NEM dobjuk el - ember dont', () => {
    // Kezenfekvo lenne: "Villa Sandahl" 39 tetelen, "Villa Sandahl Birdie"
    // 3-on, tehat az utobbi termeknev. De ez a mintazat SZERKEZETILEG AZONOS
    // azzal, amikor egy rovid elotag tobb kulon birtokot fog ossze
    // (chateau haut = haut brion + haut bailly) - ott mindketto valodi
    // boraszat. Szamokbol a ket eset nem kulonboztetheto meg.
    const inputs = [
      ...n(20, 'villa sandahl valami', ['a', 'b'], 'Villa Sandahl Rajnai Rizling'),
      ...n(3, 'villa sandahl birdie', ['a', 'b'], 'Villa Sandahl Birdie Num Num'),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).toContain('villa sandahl');
    expect(names(out)).toContain('villa sandahl birdie');
  });

  it('a tobb birtokot osszefogo elotag EGYIK birtokat sem tunteti el', () => {
    // Ez a regresszio: egy korabbi valtozat a "chateau haut bailly"-t
    // kitorolte, mert a "chateau haut" osszegzett darabszamahoz kepest
    // ritkanak latszott. Valodi boraszatot vesztettunk volna.
    const inputs = [
      ...n(13, 'chateau haut brion', ['a', 'b'], 'Chateau Haut Brion'),
      ...n(12, 'chateau haut bailly', ['a', 'b'], 'Chateau Haut Bailly'),
    ];
    const out = mineProducerCandidates(inputs, { minCount: 2, minShops: 2 });
    expect(names(out)).toEqual(expect.arrayContaining([
      'chateau haut brion', 'chateau haut bailly',
    ]));
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Bor-szokincs a jeloltek kozott
//
// A felhasznalo ezt latta a jeloltlistan:
//   Sauska · Sauska Brut · Sauska Extra Dry · Sauska Puttonyos
//
// Ezek nem kulon boraszatok, hanem ugyanannak a pinceszetnek a borai. A
// tobblet-token minden esetben BOR-szokincs - es ez az, ami megkulonbozteti
// oket a "Chateau Haut Brion" mintatol, ahol a "brion" valodi nevresz.
// ═══════════════════════════════════════════════════════════════════════════
describe('bor-szokincs a jeloltnevekben', () => {
  function inputs(rows: Array<[string, string]>): MineInput[] {
    return rows.map(([shopKey, name]) => ({
      shopKey, rawName: name, residueTokens: name.toLowerCase().split(' '),
    }));
  }

  it('a "brut" nem lehet boraszatnev', () => {
    const out = mineProducerCandidates(
      inputs([
        ['a', 'brut pezsgo egy'], ['b', 'brut pezsgo ketto'],
        ['a', 'brut pezsgo harom'], ['b', 'brut pezsgo negy'],
      ]),
      { minCount: 2, minShops: 1 },
    );
    expect(out.map((c) => c.name)).not.toContain('brut');
    expect(out.map((c) => c.name)).not.toContain('pezsgo');
  });

  it('a "Sauska Brut" beleolvad a "Sauska"-ba', () => {
    const out = mineProducerCandidates(
      inputs([
        ['a', 'sauska kekfrankos'], ['b', 'sauska furmint'], ['a', 'sauska syrah'],
        ['b', 'sauska brut'], ['a', 'sauska brut'],
      ]),
      { minCount: 2, minShops: 1 },
    );
    const names = out.map((c) => c.name);
    expect(names).toContain('sauska');
    expect(names).not.toContain('sauska brut');
  });

  it('a valodi hosszabb nev MEGMARAD, ha nem bor-szokincs a tobblet', () => {
    // Ez a vedokorlat: a "chateau haut brion" es a "chateau haut bailly"
    // ket kulon birtok, barmilyen ritkabbak is a "chateau haut"-nal.
    const out = mineProducerCandidates(
      inputs([
        ['a', 'chateau haut brion'], ['b', 'chateau haut brion'],
        ['a', 'chateau haut bailly'], ['b', 'chateau haut bailly'],
        ['a', 'chateau haut valami'],
      ]),
      { minCount: 2, minShops: 1 },
    );
    const names = out.map((c) => c.name);
    expect(names).toContain('chateau haut brion');
    expect(names).toContain('chateau haut bailly');
  });
});
