/**
 * A bor azonossaghordozoinak hard gate-jei.
 *
 * A felhasznaloi domain-definicio szerint a kanonikus azonossag =
 * BORASZAT + BORFAJTA + BORTIPUS + EVJARAT. Az adat lehet hianyos, de ahol
 * mindket oldalon ismert es elter, ott KIZAR.
 *
 * Ezek a tesztek azt bizonyitjak, hogy a kizaras tenylegesen bekovetkezik -
 * es ugyanolyan fontos: hogy a HIANYZO adat NEM zar ki, csak tartozkodast
 * eredmenyez.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreCandidate, resolveIdentityProfile, Taxonomy, identityHash,
  canonicalIdentityKey, grapeSignature,
  type CanonicalSide, type EngineInput,
} from '@radovin/domain';
import { emptyIdentityFields, type Candidate, type IdentityFields, type MatchPolicy } from '@radovin/contracts';

// A 0012 migracioban rogzitett bor-profil. Az `expression` (fantazianev)
// szandekosan NEM required: a bolti nevbol gyakran hianyzik.
const WINE_PROFILE = {
  required: ['producer', 'vintage', 'volume_ml', 'pack_count', 'packaging_type'],
  contradiction_only: [
    'grape_varieties', 'wine_style', 'vineyard', 'expression',
    'colour', 'region', 'sweetness', 'abv_percent', 'edition', 'gtin', 'appellation',
  ],
  supporting: ['country_code', 'organic'],
  not_applicable: ['age_statement_years', 'dosage_style', 'cask_finish', 'puttony'],
  vintageSensitive: true,
  gtinResolvesVintage: false,
};

const POLICY: MatchPolicy = {
  matcherVersion: '2.1.0', taxonomyVersion: '1.0.0', policyVersion: '2.1.0',
  autoMatchEnabled: true, autoMatchIdentifierOnly: false,
  thresholds: {
    autoMatch: { evidenceCoverage: 0.9, extractionQuality: 0.9, agreementScore: 0.96, topMargin: 0.1 },
    review: { minScore: 0.7 },
    ambiguousMargin: 0.03,
    volumeToleranceMl: 5,
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

/** Egy Sauska Kekfrankos 2019 alapkeszlet, amitol elterunk. */
function wine(over: Partial<IdentityFields> = {}): IdentityFields {
  return {
    ...emptyIdentityFields(),
    categoryKey: 'wine',
    producer: 'Sauska', producerId: 'p-sauska',
    vintageValue: 2019, vintageStatus: 'vintage',
    volumeMl: 750, packCount: 1, packagingType: 'standard',
    grapeVarieties: ['Kékfrankos'], grapeVarietyIds: ['g-kf'],
    grapeSignature: grapeSignature(['Kékfrankos']),
    wineStyleId: 's-red', wineStyle: 'vörös',
    ...over,
  };
}

function canonical(identity: IdentityFields): CanonicalSide {
  return {
    id: 'cv-1', displayName: 'teszt', identity,
    extractionQuality: 1.0, identityHash: identityHash({ identity }),
  };
}

function candidate(identity: IdentityFields): Candidate {
  return {
    listingId: 'sl-1', shopId: 'shop-2', shopKey: 'masikbolt', identity,
    rawName: 'teszt', normalizedName: 'teszt',
    identityHash: identityHash({ identity }),
    extractionQuality: 0.95, evidence: {}, url: 'https://example.hu/p/1',
    channels: [{ channel: 'catalog_block', rank: 1, score: 0.9 }],
  };
}

function compare(left: IdentityFields, right: IdentityFields) {
  const input: EngineInput = {
    canonical: canonical(left),
    candidates: [candidate(right)],
    profile: resolveIdentityProfile({ categoryProfile: WINE_PROFILE as never, categoryPolicy: null }),
    policy: POLICY,
    comparatorCtx: {
      aliasResolver: taxonomy.aliasResolver,
      negativeAliasCheck: taxonomy.negativeAliasCheck,
    },
    sourceHealthy: true,
  };
  return scoreCandidate(input, input.candidates[0]!);
}

// ═══════════════════════════════════════════════════════════════════════════

describe('a fajta elterese kizar', () => {
  it('olaszrizling vs kadarka - hard contradiction', () => {
    const r = compare(
      wine(),
      wine({
        grapeVarieties: ['Kadarka'], grapeVarietyIds: ['g-kad'],
        grapeSignature: grapeSignature(['Kadarka']),
      }),
    );
    expect(r.rejected).toBe(true);
    expect(r.hardContradictions.map((h) => h.field)).toContain('grapeVarietyIds');
  });

  it('a NYERS szoveges fajtanev onmagaban NEM zar ki', () => {
    // Ez a gate legfontosabb biztositeka. A `grapeVarieties` a bolt
    // specifikacios tablajabol jon, feloldatlanul - ott az "Olaszrizling" es
    // a "Welschriesling" ket kulon sztring. Ha erre ulne a hard gate, ket
    // bolt ugyanarrol a borrol hamis kizarast kapna.
    const r = compare(
      wine({ grapeVarieties: ['Olaszrizling'], grapeVarietyIds: [], grapeSignature: null }),
      wine({ grapeVarieties: ['Welschriesling'], grapeVarietyIds: [], grapeSignature: null }),
    );
    expect(r.rejected).toBe(false);
    expect(r.hardContradictions).toHaveLength(0);
  });

  it('ugyanaz a fajta kanonikus nevre feloldva NEM zar ki', () => {
    // Az egyik bolt "Welschriesling"-et irt, a masik "Olaszrizling"-et; a
    // parser mindkettot ugyanarra a kanonikus nevre oldotta fel.
    const olasz = { grapeVarieties: ['Olaszrizling'], grapeVarietyIds: ['g-or'], grapeSignature: grapeSignature(['Olaszrizling']) };
    const r = compare(wine(olasz), wine(olasz));
    expect(r.rejected).toBe(false);
    expect(r.hardContradictions).toHaveLength(0);
  });

  it('reszleges atfedes (cuvee) TARTOZKODAS, nem kizaras', () => {
    // Az egyik bolt harom fajtat sorol fel, a masik csak kettot. Ez nem
    // bizonyitja, hogy mas borrol van szo - ezert nem szabad kizarni.
    const a = ['g-cs', 'g-merlot', 'g-cf'];
    const b = ['g-cs', 'g-merlot'];
    const r = compare(
      wine({ grapeVarietyIds: a, grapeSignature: a.join('+') }),
      wine({ grapeVarietyIds: b, grapeSignature: b.join('+') }),
    );
    expect(r.rejected).toBe(false);
    const grape = r.fields.find((f) => f.field === 'grapeVarietyIds');
    expect(grape?.state).toBe('unknown');
  });

  it('ismeretlen fajta az egyik oldalon NEM zar ki', () => {
    const r = compare(wine(), wine({ grapeVarieties: [], grapeVarietyIds: [], grapeSignature: null }));
    expect(r.rejected).toBe(false);
    expect(r.fields.find((f) => f.field === 'grapeVarietyIds')?.state).toBe('unknown');
  });
});

describe('a bortipus elterese kizar', () => {
  it('vörös vs rosé - hard contradiction', () => {
    const r = compare(wine(), wine({ wineStyleId: 's-rose', wineStyle: 'rosé' }));
    expect(r.rejected).toBe(true);
    expect(r.hardContradictions.map((h) => h.field)).toContain('wineStyleId');
  });

  it('ismeretlen bortipus az egyik oldalon NEM zar ki', () => {
    const r = compare(wine(), wine({ wineStyleId: null, wineStyle: null }));
    expect(r.rejected).toBe(false);
  });
});

describe('a dulo elterese kizar', () => {
  it('Kopár vs Ördögárok - hard contradiction', () => {
    const r = compare(
      wine({ vineyardId: 'v-kopar' }),
      wine({ vineyardId: 'v-ordogarok' }),
    );
    expect(r.rejected).toBe(true);
    expect(r.hardContradictions.map((h) => h.field)).toContain('vineyardId');
  });

  it('dulo csak az egyik oldalon: tartozkodas', () => {
    const r = compare(wine({ vineyardId: 'v-kopar' }), wine());
    expect(r.rejected).toBe(false);
  });
});

describe('a borászat es az evjarat mar korabban is kizart', () => {
  it('Sauska vs Bock', () => {
    const r = compare(wine(), wine({ producer: 'Bock', producerId: 'p-bock' }));
    expect(r.rejected).toBe(true);
    expect(r.hardContradictions.map((h) => h.field)).toContain('producer');
  });

  it('2019 vs 2020', () => {
    const r = compare(wine(), wine({ vintageValue: 2020 }));
    expect(r.rejected).toBe(true);
  });
});

describe('a hianyzo fantazianev nem fojtja meg a parositast', () => {
  it('az expression ismeretlensege nem kizaro es nem is required-hiany', () => {
    // Ez a 0012 migracio lenyege: korabban az expression required volt, igy
    // egy fantazianev nelkuli bolti nev sosem erte el a bizonyitekkuszobot.
    const r = compare(wine({ expression: 'ordog' }), wine({ expression: null }));
    expect(r.rejected).toBe(false);
    expect(r.reasonCodes.join(' ')).not.toContain('EXPRESSION');
  });

  it('ket KULONBOZO ismert fantazianev viszont kizar', () => {
    const r = compare(wine({ expression: 'ordog' }), wine({ expression: 'angyal' }));
    expect(r.rejected).toBe(true);
  });
});

describe('canonicalIdentityKey', () => {
  it('ugyanaz a bor ket boltbol -> azonos kulcs', () => {
    // A ket oldal platformazonositoja kulonbozik, a kulcsnak megis egyeznie
    // kell - ezert nem hasznalhato ra az identityHash().
    expect(canonicalIdentityKey(wine())).toBe(canonicalIdentityKey(wine()));
  });

  it('elteroo fajta -> eltero kulcs', () => {
    const other = wine({ grapeSignature: grapeSignature(['Kadarka']) });
    expect(canonicalIdentityKey(wine())).not.toBe(canonicalIdentityKey(other));
  });

  it('eltero evjarat, kiszereles, tipus es dulo -> eltero kulcs', () => {
    const base = canonicalIdentityKey(wine());
    expect(canonicalIdentityKey(wine({ vintageValue: 2020 }))).not.toBe(base);
    expect(canonicalIdentityKey(wine({ volumeMl: 1500 }))).not.toBe(base);
    expect(canonicalIdentityKey(wine({ wineStyleId: 's-rose' }))).not.toBe(base);
    expect(canonicalIdentityKey(wine({ vineyardId: 'v-kopar' }))).not.toBe(base);
  });

  it('a fantazianev NEM resze a kulcsnak', () => {
    // Tudatosan vallalt kompromisszum: a fantazianev hianyozhat a bolti
    // nevbol, ezert nem lehet a klaszterezes alapja. A kulonbseget a
    // hard gate fogja meg, ha mindket oldalon ismert.
    expect(canonicalIdentityKey(wine({ expression: 'ordog' })))
      .toBe(canonicalIdentityKey(wine({ expression: 'angyal' })));
  });
});
