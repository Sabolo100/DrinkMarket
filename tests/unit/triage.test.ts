/**
 * A harmas szuro: mit hagy jova a gep, mi megy emberhez, mi esik ki.
 *
 * Ket allitas vedelme, es mindketto dragan romlik el:
 *
 *   1. A gep CSAK teljes bizonyitott azonossagnal donthet egyedul. Nem magas
 *      pontszamnal - az `agreementScore` csak az ISMERT mezoket atlagolja,
 *      ezert ket ismert mezobol is lehet 1.0.
 *   2. Az ar SOHA nem utasit el. A rendszer terméke epp az arkulonbseg; egy
 *      valodi 30%-os elonyt eldobni onveszelyes lenne. Az ar annyit tehet,
 *      hogy egy kiugro aranynal emberre bizza a dontest.
 */
import { describe, it, expect } from 'vitest';
import {
  decideMatch, resolveIdentityProfile, Taxonomy, identityHash,
  type CanonicalSide, type EngineInput,
} from '@radovin/domain';
import {
  emptyIdentityFields, type Candidate, type IdentityFields, type MatchPolicy,
} from '@radovin/contracts';

/** A 0018 + 0019 migracio szerinti eles bor-profil. */
const WINE_PROFILE = {
  // A 0019 utan: a kiszereles NEM kotelezo, csak ellentmondasjelzo.
  required: ['producer', 'vintage', 'pack_count', 'packaging_type'],
  contradiction_only: [
    'grape_varieties', 'wine_style', 'vineyard', 'expression',
    'colour', 'region', 'sweetness', 'abv_percent', 'edition', 'gtin', 'volume_ml',
  ],
  supporting: ['country_code', 'organic'],
  not_applicable: ['age_statement_years', 'dosage_style', 'cask_finish', 'puttony'],
  vintageSensitive: true,
  gtinResolvesVintage: false,
  // A 0019 migracio szerint: a kiszereles KIKERULT a magbol, mert a boltok
  // tobb mint felenel sehol nem szerepel. `contradiction_only` marad, tehat
  // ismert elteres eseten tovabbra is kizar.
  identity_core: [
    'producer', 'grape_varieties', 'colour', 'vintage',
    'pack_count', 'packaging_type',
  ],
};

const POLICY: MatchPolicy = {
  matcherVersion: '2.1.0', taxonomyVersion: '1.0.0', policyVersion: '2.1.0',
  // A REGI ut kikapcsolva, hogy bizonyithato legyen: amit latunk, azt az uj
  // ut hozta, nem a pontszam-alapu automatika.
  autoMatchEnabled: false,
  autoMatchIdentifierOnly: true,
  autoMatchIdentityComplete: true,
  thresholds: {
    autoMatch: { evidenceCoverage: 0.9, extractionQuality: 0.9, agreementScore: 0.96, topMargin: 0.1 },
    review: { minScore: 0.7 },
    ambiguousMargin: 0.03,
    volumeToleranceMl: 5,
    priceRatioMax: 2.0,
  },
  fieldWeights: {
    producer: 0.18, expression: 0.28, vintage: 0.16, volume: 0.16,
    category: 0.06, region: 0.06, abv: 0.04, gtin: 0.04, image: 0.02,
  },
};

const taxonomy = new Taxonomy({
  brands: [], producers: [], categories: [], aliases: [],
  negativeAliases: [], identityTerms: [], version: '1.0.0',
});

const KEK = 'grape-kekfrankos';
const OLASZ = 'grape-olaszrizling';

/** Egy teljesen kitoltott bor-azonossag - minden magmezo ismert. */
function wine(over: Partial<IdentityFields> = {}): IdentityFields {
  return {
    ...emptyIdentityFields(),
    categoryKey: 'wine',
    producer: 'Sauska', producerId: 'prod-sauska',
    grapeVarietyIds: [KEK], grapeVarieties: ['Kékfrankos'],
    grapeSignature: 'kekfrankos',
    colour: 'red',
    vintageValue: 2019, vintageStatus: 'vintage',
    volumeMl: 750, packCount: 1, packagingType: 'standard',
    ...over,
  };
}

function canonical(over: Partial<IdentityFields> = {}, price: number | null = 4990): CanonicalSide {
  const identity = wine(over);
  return {
    id: 'cv-1', displayName: 'Sauska Kékfrankos 2019',
    identity, extractionQuality: 1.0,
    identityHash: identityHash({ identity }),
    referencePriceHuf: price,
  };
}

function candidate(over: Partial<IdentityFields> = {}, opts: Partial<Candidate> = {}): Candidate {
  const identity = wine(over);
  return {
    listingId: opts.listingId ?? 'sl-1',
    shopId: 'shop-2', shopKey: 'borhalo', identity,
    rawName: '2019 Sauska Kékfrankos 0,75 l',
    normalizedName: '2019 sauska kekfrankos 0,75 l',
    identityHash: identityHash({ identity }),
    // Szandekosan ALACSONY: a valos webshopadatokon ez a jellemzo, es a
    // regi ut 0.90-es kuszobe emiatt teljesithetetlen.
    extractionQuality: opts.extractionQuality ?? 0.67,
    evidence: {}, url: 'https://borhalo.hu/p/1',
    channels: opts.channels ?? [{ channel: 'catalog_block', rank: 1, score: 0.9 }],
    priceHuf: opts.priceHuf === undefined ? 5690 : opts.priceHuf,
    ...opts,
  };
}

function decide(can: CanonicalSide, cands: Candidate[], policyOver: Partial<MatchPolicy> = {}) {
  const input: EngineInput = {
    canonical: can, candidates: cands,
    profile: resolveIdentityProfile({ categoryProfile: WINE_PROFILE as never, categoryPolicy: null }),
    policy: { ...POLICY, ...policyOver },
    comparatorCtx: {
      aliasResolver: taxonomy.aliasResolver,
      negativeAliasCheck: taxonomy.negativeAliasCheck,
    },
    sourceHealthy: true,
  };
  return decideMatch(input);
}

describe('teljes bizonyitott azonossag -> a gep dont', () => {
  it('ugyanaz a bor ket boltbol -> auto_verified', () => {
    const d = decide(canonical(), [candidate()]);
    expect(d.status).toBe('auto_verified');
    expect(d.reasonCodes).toContain('IDENTITY_COMPLETE');
  });

  it('a gyenge kinyeresi minoseg NEM akadaly, ha az azonossag teljes', () => {
    // A regi ut `extractionQuality >= 0.90`-t kovetel. Az uj ut mast kerdez:
    // ha minden magmezo bizonyitott, akkor a tobbi mezo minosege nem szamit.
    const d = decide(canonical(), [candidate({}, { extractionQuality: 0.31 })]);
    expect(d.status).toBe('auto_verified');
  });

  it('GTIN nelkul is jovahagy - bornal az EAN ugysem azonosit evjaratot', () => {
    const d = decide(canonical({ gtin: null }), [candidate({ gtin: null })]);
    expect(d.status).toBe('auto_verified');
  });
});

describe('hianyzo bizonyitek -> emberhez', () => {
  it('ismeretlen fajta az egyik oldalon -> NEM auto', () => {
    const d = decide(canonical(), [candidate({
      grapeVarietyIds: [], grapeVarieties: [], grapeSignature: null,
    })]);
    expect(d.status).not.toBe('auto_verified');
  });

  it('ismeretlen evjarat az egyik oldalon -> NEM auto', () => {
    const d = decide(canonical(), [candidate({ vintageValue: null, vintageStatus: 'unknown' })]);
    expect(d.status).not.toBe('auto_verified');
  });

  it('ismeretlen kiszereles -> ATMEGY (a kiszereles nincs a magban)', () => {
    // A boltok tobb mint felenel nincs kiszereles sem a nevben, sem a
    // spec-tablaban. Ha ezt bizonyitando mezonek tartanank, a borok tobbsege
    // sosem tudna automatikusan parosodni.
    const d = decide(canonical(), [candidate({ volumeMl: null })]);
    expect(d.status).toBe('auto_verified');
  });

  it('ismeretlen kiszereles MINDKET oldalon -> atmegy', () => {
    const d = decide(canonical({ volumeMl: null }), [candidate({ volumeMl: null })]);
    expect(d.status).toBe('auto_verified');
  });

  it('ismeretlen szin -> NEM auto', () => {
    const d = decide(canonical(), [candidate({ colour: null })]);
    expect(d.status).not.toBe('auto_verified');
  });

  it('a magas pontszam ONMAGABAN nem eleg', () => {
    // Minden ISMERT mezo egyezik, tehat az agreementScore 1.0 - de a fajta
    // es a szin egyik oldalon sem ismert. A pontszam nem tudja, mit nem tud.
    const bare = { grapeVarietyIds: [], grapeVarieties: [], grapeSignature: null, colour: null };
    const d = decide(canonical(bare), [candidate(bare)]);
    expect(d.status).not.toBe('auto_verified');
    expect(d.agreementScore).toBeGreaterThan(0.9);
  });
});

describe('ellentmondas -> kizarva, sosem auto', () => {
  it('mas fajta -> rejected', () => {
    const d = decide(canonical(), [candidate({
      grapeVarietyIds: [OLASZ], grapeVarieties: ['Olaszrizling'],
      grapeSignature: 'olaszrizling', colour: 'white',
    })]);
    expect(d.status).toBe('rejected');
  });

  it('mas evjarat -> rejected', () => {
    const d = decide(canonical(), [candidate({ vintageValue: 2020 })]);
    expect(d.status).toBe('rejected');
  });

  it('mas kiszereles -> rejected', () => {
    const d = decide(canonical(), [candidate({ volumeMl: 1500 })]);
    expect(d.status).toBe('rejected');
  });
});

describe('az ar: sosem utasit el, csak az automatikat tiltja', () => {
  it('30%-os arkulonbseg -> ATMEGY automatikusan', () => {
    // Ez a rendszer TERMEKE. Ha ezt eldobnank, a legertekesebb talalatokat
    // dobnank el: a magyar borpiacon ket webshop kozott ez normalis szoras.
    const d = decide(canonical({}, ), [candidate({}, { priceHuf: 6487 })]);
    expect(d.status).toBe('auto_verified');
  });

  it('80%-os kulonbseg -> meg atmegy', () => {
    const d = decide(canonical(), [candidate({}, { priceHuf: 8982 })]);
    expect(d.status).toBe('auto_verified');
  });

  it('haromszoros ar -> emberhez, de NEM elutasitva', () => {
    // A belepo es a premium tetel ugyanattol a boraszattol sokszorosan elter.
    // A 2x-es kuszob emellett a jeloletlen magnumot is elkapja - eppen azt a
    // kockazatot, amit a kiszereles magbol valo kivetele nyitott.
    const d = decide(canonical(), [candidate({}, { priceHuf: 14970 })]);
    expect(d.status).not.toBe('auto_verified');
    expect(d.status).not.toBe('rejected');
    expect(d.reasonCodes).toContain('PRICE_RATIO_IMPLAUSIBLE');
  });

  it('a kiugro arany sem tesz kizaro ellentmondast', () => {
    const d = decide(canonical(), [candidate({}, { priceHuf: 99000 })]);
    expect(d.hardContradictions ?? []).toHaveLength(0);
  });

  it('hianyzo ar az egyik oldalon -> nem blokkol', () => {
    // A keszlethiany vagy egy kinyeresi hiba miatt ismeretlen ar nem tehet
    // gyanussa egy egyebkent bizonyitott azonossagot.
    const d = decide(canonical({}, null), [candidate({}, { priceHuf: null })]);
    expect(d.status).toBe('auto_verified');
  });

  it('a kuszob allithato', () => {
    const strict = { ...POLICY.thresholds, priceRatioMax: 1.1 };
    const d = decide(canonical(), [candidate({}, { priceHuf: 5690 })], { thresholds: strict });
    expect(d.status).not.toBe('auto_verified');
    expect(d.reasonCodes).toContain('PRICE_RATIO_IMPLAUSIBLE');
  });
});

describe('vedokorlatok', () => {
  it('kikapcsolt kapcsoloval nincs automatikus jovahagyas', () => {
    const d = decide(canonical(), [candidate()], { autoMatchIdentityComplete: false });
    expect(d.status).not.toBe('auto_verified');
  });

  it('ures azonossagmag eseten nincs automatikus jovahagyas', () => {
    // A besorolatlan termek ide esik. A hallgatas nem jelenthet engedelyt.
    const input: EngineInput = {
      canonical: canonical(), candidates: [candidate()],
      profile: resolveIdentityProfile({
        categoryProfile: { ...WINE_PROFILE, identity_core: [] } as never,
        categoryPolicy: null,
      }),
      policy: POLICY,
      comparatorCtx: {
        aliasResolver: taxonomy.aliasResolver,
        negativeAliasCheck: taxonomy.negativeAliasCheck,
      },
      sourceHealthy: true,
    };
    expect(decideMatch(input).status).not.toBe('auto_verified');
  });

  it('korabbi emberi elutasitas utan sosem auto', () => {
    const cand = candidate();
    const input: EngineInput = {
      canonical: canonical(), candidates: [cand],
      profile: resolveIdentityProfile({ categoryProfile: WINE_PROFILE as never, categoryPolicy: null }),
      policy: POLICY,
      comparatorCtx: {
        aliasResolver: taxonomy.aliasResolver,
        negativeAliasCheck: taxonomy.negativeAliasCheck,
      },
      negativeHistory: new Map([[cand.listingId, 1]]),
      sourceHealthy: true,
    };
    expect(decideMatch(input).status).not.toBe('auto_verified');
  });

  it('ket egyforma eros jelolt eseten nincs automatikus jovahagyas', () => {
    // Ha ket listing ugyanabban a boltban egyformán jo, a gep nem valaszthat.
    const d = decide(canonical(), [
      candidate({}, { listingId: 'sl-a' }),
      candidate({}, { listingId: 'sl-b' }),
    ]);
    expect(d.status).not.toBe('auto_verified');
  });
});

describe('az indoklas igazat mond', () => {
  it('nyitott teljes-azonossagi ut mellett NEM ir "automatika kikapcsolva"-t', () => {
    // A regi kapcsolo (`auto_match`) tenyleg ki van kapcsolva, de nem AZ volt
    // az ok - az uj ut nyitva allt, csak a bizonyitek nem volt teljes. Ezt
    // kiirni felrevezetne azt, aki az indoklas alapjan probal donteni.
    const d = decide(canonical(), [candidate({ colour: null })]);
    expect(d.status).not.toBe('auto_verified');
    expect(d.reasonCodes).not.toContain('AUTO_MATCH_DISABLED');
  });

  it('ha MINDKET ut zarva, akkor viszont kiirja', () => {
    const d = decide(canonical(), [candidate()], {
      autoMatchEnabled: false, autoMatchIdentityComplete: false,
    });
    expect(d.reasonCodes).toContain('AUTO_MATCH_DISABLED');
  });

  it('teljes azonossagnal kimondja, hogy az', () => {
    const d = decide(canonical(), [candidate()]);
    expect(d.identityComplete).toBe(true);
    expect(d.explanationHu).toContain('Minden azonossaghordozo');
  });

  it('a kiugro ararany bekerul a magyarazatba', () => {
    const d = decide(canonical(), [candidate({}, { priceHuf: 19960 })]);
    expect(d.explanationHu).toContain('4x');
  });
});
