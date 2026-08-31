/**
 * Kotelezo tortenelmi regresszios esetek (spec 32.2).
 * Minden ismert hard negative 100%-ban elutasitando vagy review-ra kuldendo.
 * Hard contradictiont tartalmazo parbol 0 auto-match.
 */
import { describe, it, expect } from 'vitest';
import {
  decideMatch, scoreCandidate, resolveIdentityProfile, Taxonomy,
  identityHash, detectDrift, type CanonicalSide, type EngineInput,
} from '@radovin/domain';
import { emptyIdentityFields, type Candidate, type IdentityFields, type MatchPolicy } from '@radovin/contracts';

// ── Fixture epitok ──────────────────────────────────────────────────────────

const WINE_PROFILE = {
  required: ['producer', 'expression', 'vintage', 'volume_ml', 'pack_count', 'packaging_type'],
  contradiction_only: ['colour', 'region', 'sweetness', 'abv_percent', 'edition', 'gtin'],
  supporting: ['country_code'],
  not_applicable: ['age_statement_years', 'dosage_style', 'cask_finish', 'puttony'],
  vintageSensitive: true,
  gtinResolvesVintage: false,
};

const SPIRIT_PROFILE = {
  required: ['brand', 'expression', 'volume_ml', 'pack_count', 'packaging_type'],
  contradiction_only: ['age_statement_years', 'edition', 'cask_finish', 'abv_percent', 'gtin'],
  supporting: ['region'],
  not_applicable: ['dosage_style', 'puttony', 'grape_varieties', 'vintage'],
  vintageSensitive: false,
  gtinResolvesVintage: true,
};

const ASZU_PROFILE = {
  required: ['producer', 'expression', 'vintage', 'puttony', 'volume_ml', 'pack_count', 'packaging_type'],
  contradiction_only: ['region', 'sweetness', 'abv_percent', 'edition', 'gtin'],
  supporting: [],
  not_applicable: ['age_statement_years', 'dosage_style', 'cask_finish'],
  vintageSensitive: true,
  gtinResolvesVintage: false,
};

const SPARKLING_PROFILE = {
  required: ['producer', 'expression', 'dosage_style', 'vintage_status', 'volume_ml', 'pack_count', 'packaging_type'],
  contradiction_only: ['vintage', 'region', 'abv_percent', 'edition', 'gtin'],
  supporting: [],
  not_applicable: ['age_statement_years', 'cask_finish', 'puttony'],
  vintageSensitive: true,
  gtinResolvesVintage: false,
};

const POLICY: MatchPolicy = {
  matcherVersion: '2.1.0',
  taxonomyVersion: '1.0.0',
  policyVersion: '2.1.0',
  autoMatchEnabled: true,           // a tesztekben BEKAPCSOLVA, hogy bizonyithato legyen,
  autoMatchIdentifierOnly: false,   // hogy a hard gate akkor is fog
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
  negativeAliases: [
    { leftNorm: 'black label', rightNorm: 'double black', categoryKey: 'whisky', reason: 'Ket kulon Johnnie Walker expression.' },
    { leftNorm: 'gin', rightNorm: 'sloe gin', categoryKey: 'gin', reason: 'A Sloe Gin nem azonos a sima ginnel.' },
  ],
  identityTerms: [], version: '1.0.0',
});

function ident(over: Partial<IdentityFields>): IdentityFields {
  return { ...emptyIdentityFields(), packagingType: 'standard', ...over };
}

function canonical(name: string, over: Partial<IdentityFields>): CanonicalSide {
  const identity = ident(over);
  return { id: 'cv-1', displayName: name, identity, extractionQuality: 1.0, identityHash: identityHash({ identity }) };
}

function candidate(name: string, over: Partial<IdentityFields>, opts: Partial<Candidate> = {}): Candidate {
  const identity = ident(over);
  return {
    listingId: opts.listingId ?? `sl-${Math.random().toString(36).slice(2, 8)}`,
    shopId: 'shop-1', shopKey: 'testshop', identity,
    rawName: name, normalizedName: name.toLowerCase(),
    identityHash: identityHash({ identity }),
    extractionQuality: opts.extractionQuality ?? 0.95,
    evidence: {}, url: 'https://example.hu/p/1',
    channels: opts.channels ?? [{ channel: 'catalog_block', rank: 1, score: 0.9 }],
    ...opts,
  };
}

function engine(
  can: CanonicalSide,
  cands: Candidate[],
  profileJson: Record<string, unknown>,
  policyOver: Partial<MatchPolicy> = {},
): EngineInput {
  return {
    canonical: can,
    candidates: cands,
    profile: resolveIdentityProfile({ categoryProfile: profileJson as never, categoryPolicy: null }),
    policy: { ...POLICY, ...policyOver },
    comparatorCtx: {
      aliasResolver: taxonomy.aliasResolver,
      negativeAliasCheck: taxonomy.negativeAliasCheck,
    },
    sourceHealthy: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('hard contradiction: SOHA nincs auto-match (spec 32.4)', () => {
  it('Black Label vs Double Black - elutasitas', () => {
    const can = canonical('Johnnie Walker Black Label 12 0,7 l', {
      categoryKey: 'whisky', brand: 'Johnnie Walker', expression: 'black label',
      edition: 'black label', ageStatementYears: 12, volumeMl: 700,
    });
    const cand = candidate('Johnnie Walker Double Black 0,7 l', {
      categoryKey: 'whisky', brand: 'Johnnie Walker', expression: 'double black',
      edition: 'double black', volumeMl: 700,
    });
    const d = decideMatch(engine(can, [cand], SPIRIT_PROFILE));
    expect(d.status).toBe('rejected');
    expect(d.hardContradictions.length).toBeGreaterThan(0);
  });

  it('8 Years vs 12 Years - eltero korjeloles', () => {
    const can = canonical('Glenfiddich 12 Years Old 0,7 l', {
      categoryKey: 'whisky', brand: 'Glenfiddich', expression: 'glenfiddich', ageStatementYears: 12, volumeMl: 700,
    });
    const cand = candidate('Glenfiddich 8 Years Old 0,7 l', {
      categoryKey: 'whisky', brand: 'Glenfiddich', expression: 'glenfiddich', ageStatementYears: 8, volumeMl: 700,
    });
    const d = decideMatch(engine(can, [cand], SPIRIT_PROFILE));
    expect(d.status).toBe('rejected');
    expect(d.hardContradictions.some((h) => h.field === 'ageStatementYears')).toBe(true);
  });

  it('5 vs 6 puttonyos aszu - eltero puttonyszam', () => {
    const can = canonical('Tokaji Aszu 5 puttonyos 2017 0,5 l', {
      categoryKey: 'tokaji_aszu', producer: 'Disznoko', expression: 'tokaji aszu',
      vintageValue: 2017, vintageStatus: 'vintage', puttony: 5, volumeMl: 500,
    });
    const cand = candidate('Tokaji Aszu 6 puttonyos 2017 0,5 l', {
      categoryKey: 'tokaji_aszu', producer: 'Disznoko', expression: 'tokaji aszu',
      vintageValue: 2017, vintageStatus: 'vintage', puttony: 6, volumeMl: 500,
    });
    const d = decideMatch(engine(can, [cand], ASZU_PROFILE));
    expect(d.status).toBe('rejected');
    expect(d.hardContradictions.some((h) => h.field === 'puttony')).toBe(true);
  });

  it('0,7 l vs 1 l - eltero kiszereles', () => {
    const can = canonical('Jack Daniels 0,7 l', { categoryKey: 'whisky', brand: 'Jack Daniels', expression: 'old no 7', volumeMl: 700 });
    const cand = candidate('Jack Daniels 1 l', { categoryKey: 'whisky', brand: 'Jack Daniels', expression: 'old no 7', volumeMl: 1000 });
    const d = decideMatch(engine(can, [cand], SPIRIT_PROFILE));
    expect(d.status).toBe('rejected');
    expect(d.hardContradictions.some((h) => h.field === 'volumeMl')).toBe(true);
  });

  it('0,75 l vs 1,5 l Magnum', () => {
    const can = canonical('Gere Roka Pinot Noir 2023 0,75 l', {
      categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka pinot noir',
      vintageValue: 2023, vintageStatus: 'vintage', volumeMl: 750,
    });
    const cand = candidate('Gere Roka Pinot Noir 2023 Magnum 1,5 l', {
      categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka pinot noir',
      vintageValue: 2023, vintageStatus: 'vintage', volumeMl: 1500,
    });
    const d = decideMatch(engine(can, [cand], WINE_PROFILE));
    expect(d.status).toBe('rejected');
  });

  it('sima palack vs diszdoboz - alapertelmezesben nem azonos', () => {
    const can = canonical('Chivas Regal 12 0,7 l', {
      categoryKey: 'whisky', brand: 'Chivas Regal', expression: 'chivas regal',
      ageStatementYears: 12, volumeMl: 700, packagingType: 'standard',
    });
    const cand = candidate('Chivas Regal 12 0,7 l diszdobozban', {
      categoryKey: 'whisky', brand: 'Chivas Regal', expression: 'chivas regal',
      ageStatementYears: 12, volumeMl: 700, packagingType: 'gift_box',
    });
    const d = decideMatch(engine(can, [cand], SPIRIT_PROFILE));
    expect(d.status).toBe('rejected');
    expect(d.hardContradictions.some((h) => h.field === 'packagingType')).toBe(true);
  });

  it('diszdoboz ELFOGADHATO, ha a comparison policy explicit engedi (spec 3.1)', () => {
    const can = canonical('Chivas Regal 12 0,7 l', {
      categoryKey: 'whisky', brand: 'Chivas Regal', expression: 'chivas regal',
      ageStatementYears: 12, volumeMl: 700, packagingType: 'standard',
    });
    const cand = candidate('Chivas Regal 12 0,7 l diszdobozban', {
      categoryKey: 'whisky', brand: 'Chivas Regal', expression: 'chivas regal',
      ageStatementYears: 12, volumeMl: 700, packagingType: 'gift_box',
    });
    const input: EngineInput = {
      ...engine(can, [cand], SPIRIT_PROFILE),
      profile: resolveIdentityProfile({
        categoryProfile: SPIRIT_PROFILE as never,
        categoryPolicy: { giftBoxEquivalent: true, exceptionReason: 'Admin altal jovahagyott kivetel' } as never,
      }),
    };
    const d = decideMatch(input);
    expect(d.status).not.toBe('rejected');
  });

  it('eltero evjaratu Bukolyi Joy', () => {
    const can = canonical('Bukolyi Joy 2019 0,75 l', {
      categoryKey: 'wine', producer: 'Bukolyi', expression: 'joy',
      vintageValue: 2019, vintageStatus: 'vintage', volumeMl: 750,
    });
    const cand = candidate('Bukolyi Joy 2021 0,75 l', {
      categoryKey: 'wine', producer: 'Bukolyi', expression: 'joy',
      vintageValue: 2021, vintageStatus: 'vintage', volumeMl: 750,
    });
    const d = decideMatch(engine(can, [cand], WINE_PROFILE));
    expect(d.status).toBe('rejected');
    expect(d.hardContradictions.some((h) => h.field === 'vintage')).toBe(true);
  });

  it('6 x 0,75 l vs 1 x 0,75 l - eltero pack count', () => {
    const can = canonical('Gere Roka 2023 0,75 l', {
      categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka',
      vintageValue: 2023, vintageStatus: 'vintage', volumeMl: 750, packCount: 1,
    });
    const cand = candidate('Gere Roka 2023 karton 6 x 0,75 l', {
      categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka',
      vintageValue: 2023, vintageStatus: 'vintage', volumeMl: 750, packCount: 6,
    });
    const d = decideMatch(engine(can, [cand], WINE_PROFILE));
    expect(d.status).toBe('rejected');
    expect(d.hardContradictions.some((h) => h.field === 'packCount')).toBe(true);
  });

  it('NV vs vintage pezsgo', () => {
    const can = canonical('Moet & Chandon Brut Imperial NV 0,75 l', {
      categoryKey: 'champagne', producer: 'Moet & Chandon', expression: 'brut imperial',
      dosageStyle: 'brut', vintageStatus: 'non_vintage', volumeMl: 750,
    });
    const cand = candidate('Moet & Chandon Brut Imperial 2015 0,75 l', {
      categoryKey: 'champagne', producer: 'Moet & Chandon', expression: 'brut imperial',
      dosageStyle: 'brut', vintageStatus: 'vintage', vintageValue: 2015, volumeMl: 750,
    });
    const d = decideMatch(engine(can, [cand], SPARKLING_PROFILE));
    expect(d.status).toBe('rejected');
  });

  it('eltero GTIN mindket oldalon ismerten', () => {
    const can = canonical('Zwack Unicum 0,7 l', {
      categoryKey: 'liqueur', brand: 'Zwack', expression: 'unicum', volumeMl: 700, gtin: '5998400100019',
    });
    const cand = candidate('Zwack Unicum 0,7 l', {
      categoryKey: 'liqueur', brand: 'Zwack', expression: 'unicum', volumeMl: 700, gtin: '5998400100026',
    });
    const d = decideMatch(engine(can, [cand], SPIRIT_PROFILE));
    expect(d.status).toBe('rejected');
    expect(d.hardContradictions.some((h) => h.field === 'gtin')).toBe(true);
  });

  it('negativ alias (sloe gin) kizar', () => {
    const can = canonical('Gordons Gin 0,7 l', {
      categoryKey: 'gin', brand: 'Gordons', expression: 'gin', volumeMl: 700,
    });
    const cand = candidate('Gordons Sloe Gin 0,7 l', {
      categoryKey: 'gin', brand: 'Gordons', expression: 'sloe gin', volumeMl: 700,
    });
    const d = decideMatch(engine(can, [cand], SPIRIT_PROFILE));
    expect(d.status).toBe('rejected');
  });
});

describe('unknown kezelese: SOHA nem valik match-cse (spec 38/7)', () => {
  it('hianyzo kotelezo evjarat eseten nincs auto-match', () => {
    const can = canonical('Gere Roka Pinot Noir 2023 0,75 l', {
      categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka pinot noir',
      vintageValue: 2023, vintageStatus: 'vintage', volumeMl: 750,
    });
    const cand = candidate('Gere Roka Pinot Noir 0,75 l', {
      categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka pinot noir',
      vintageStatus: 'unknown', volumeMl: 750,
    });
    const d = decideMatch(engine(can, [cand], WINE_PROFILE));
    expect(d.status).not.toBe('auto_verified');
    expect(d.reasonCodes).toContain('REQUIRED_VINTAGE_UNKNOWN');
    expect(d.fieldResults['vintage']?.state).toBe('unknown');
  });

  it('azonos EAN, de bizonytalan vintage -> nem auto-match bornal (spec 10.2)', () => {
    const can = canonical('Gere Roka 2022 0,75 l', {
      categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka',
      vintageValue: 2022, vintageStatus: 'vintage', volumeMl: 750, gtin: '5999999000015',
    });
    const cand = candidate('Gere Roka 0,75 l', {
      categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka',
      vintageStatus: 'unknown', volumeMl: 750, gtin: '5999999000015',
    }, { channels: [{ channel: 'gtin', rank: 1, score: 1 }] });
    const d = decideMatch(engine(can, [cand], WINE_PROFILE));
    expect(d.status).not.toBe('auto_verified');
    expect(d.reasonCodes).toContain('EAN_MATCH_VINTAGE_UNPROVEN');
  });

  it('hianyzo kotelezo kiszereles review-ba kerul, nem elutasitasba', () => {
    const can = canonical('Tokaji Furmint 2021 0,75 l', {
      categoryKey: 'wine', producer: 'Oremus', expression: 'mandolas furmint',
      vintageValue: 2021, vintageStatus: 'vintage', volumeMl: 750,
    });
    const cand = candidate('Oremus Mandolas Furmint 2021', {
      categoryKey: 'wine', producer: 'Oremus', expression: 'mandolas furmint',
      vintageValue: 2021, vintageStatus: 'vintage', volumeMl: null,
    });
    const d = decideMatch(engine(can, [cand], WINE_PROFILE));
    expect(['needs_review', 'insufficient_evidence']).toContain(d.status);
    expect(d.reasonCodes).toContain('REQUIRED_VOLUME_UNKNOWN');
  });
});

describe('dontesi politika (spec 15.6)', () => {
  it('teljes egyezes eseten auto-match, ha a flag be van kapcsolva', () => {
    const shared = {
      categoryKey: 'wine' as const, producer: 'Gere Attila', expression: 'roka pinot noir',
      vintageValue: 2023, vintageStatus: 'vintage' as const, volumeMl: 750,
      packCount: 1, packagingType: 'standard' as const, colour: 'red', region: 'Villany',
    };
    const can = canonical('Gere Roka Pinot Noir 2023 0,75 l', shared);
    const cand = candidate('Gere Attila Roka Pinot Noir 2023 0,75 l', shared, { extractionQuality: 0.97 });
    const d = decideMatch(engine(can, [cand], WINE_PROFILE));
    expect(d.status).toBe('auto_verified');
    expect(d.contradictionCount).toBe(0);
  });

  it('kikapcsolt auto_match flag eseten review, nem auto (spec 15.6 pilot)', () => {
    const shared = {
      categoryKey: 'wine' as const, producer: 'Gere Attila', expression: 'roka pinot noir',
      vintageValue: 2023, vintageStatus: 'vintage' as const, volumeMl: 750,
      packCount: 1, packagingType: 'standard' as const,
    };
    const can = canonical('Gere Roka Pinot Noir 2023 0,75 l', shared);
    const cand = candidate('Gere Attila Roka Pinot Noir 2023 0,75 l', shared);
    const d = decideMatch(engine(can, [cand], WINE_PROFILE, { autoMatchEnabled: false }));
    expect(d.status).toBe('needs_review');
    expect(d.reasonCodes).toContain('AUTO_MATCH_DISABLED');
  });

  it('ket azonos erossegu jelolt -> ambiguous', () => {
    const shared = {
      categoryKey: 'whisky' as const, brand: 'Ardbeg', expression: 'ardbeg 10',
      ageStatementYears: 10, volumeMl: 700, packCount: 1, packagingType: 'standard' as const,
    };
    const can = canonical('Ardbeg 10 Years 0,7 l', shared);
    const a = candidate('Ardbeg Ten 10 eves 0,7 l', shared, { listingId: 'a' });
    const b = candidate('Ardbeg Ten 10 eves 0,7 l', shared, { listingId: 'b' });
    const d = decideMatch(engine(can, [a, b], SPIRIT_PROFILE));
    expect(d.status).toBe('ambiguous');
    expect(d.reasonCodes).toContain('MULTIPLE_SIMILAR_VARIANTS');
  });

  it('nincs jelolt egeszseges forras mellett -> not_found_after_full_search', () => {
    const can = canonical('Ismeretlen Bor 2020 0,75 l', {
      categoryKey: 'wine', producer: 'Ismeretlen', expression: 'bor',
      vintageValue: 2020, vintageStatus: 'vintage', volumeMl: 750,
    });
    const d = decideMatch(engine(can, [], WINE_PROFILE));
    expect(d.status).toBe('not_found_after_full_search');
    expect(d.reasonCodes).toContain('NO_CANDIDATE');
  });

  it('beteg forras eseten source_unhealthy, NEM not_found (spec 16.1)', () => {
    const can = canonical('Barmilyen Bor 2020 0,75 l', {
      categoryKey: 'wine', producer: 'X', expression: 'bor', vintageValue: 2020,
      vintageStatus: 'vintage', volumeMl: 750,
    });
    const input = { ...engine(can, [], WINE_PROFILE), sourceHealthy: false };
    const d = decideMatch(input);
    expect(d.status).toBe('source_unhealthy');
  });

  it('ember altal igazolt kapcsolatot automatika nem ir felul (spec 17.4)', () => {
    const shared = {
      categoryKey: 'whisky' as const, brand: 'Lagavulin', expression: 'lagavulin 16',
      ageStatementYears: 16, volumeMl: 700,
    };
    const can = canonical('Lagavulin 16 0,7 l', shared);
    const cand = candidate('Lagavulin 16 eves 0,7 l', shared, { listingId: 'locked' });
    const input: EngineInput = {
      ...engine(can, [cand], SPIRIT_PROFILE),
      verifiedListingIds: new Set(['locked']),
    };
    const d = decideMatch(input);
    expect(d.status).toBe('human_verified');
  });

  it('a negativ memoria csokkenti a dontesi erot (spec 14.3)', () => {
    const shared = {
      categoryKey: 'whisky' as const, brand: 'Talisker', expression: 'talisker 10',
      ageStatementYears: 10, volumeMl: 700,
    };
    const can = canonical('Talisker 10 0,7 l', shared);
    const cand = candidate('Talisker 10 eves 0,7 l', shared, { listingId: 'rejected-before' });
    const withHistory: EngineInput = {
      ...engine(can, [cand], SPIRIT_PROFILE),
      negativeHistory: new Map([['rejected-before', 2]]),
    };
    const withoutHistory = engine(can, [cand], SPIRIT_PROFILE);
    const a = scoreCandidate(withHistory, cand);
    const b = scoreCandidate(withoutHistory, cand);
    expect(a.decisionStrength).toBeLessThan(b.decisionStrength);
    expect(a.reasonCodes).toContain('NEGATIVE_HISTORY');
  });

  it('rovid, hasonlo markanev nem egyezik fuzzy alapon (spec 13.3)', () => {
    const can = canonical('Kikelet Furmint 2021 0,75 l', {
      categoryKey: 'wine', producer: 'Kikelet', expression: 'furmint',
      vintageValue: 2021, vintageStatus: 'vintage', volumeMl: 750,
    });
    const cand = candidate('Kikelt Furmint 2021 0,75 l', {
      categoryKey: 'wine', producer: 'Kikelt', expression: 'furmint',
      vintageValue: 2021, vintageStatus: 'vintage', volumeMl: 750,
    });
    const d = decideMatch(engine(can, [cand], WINE_PROFILE));
    expect(d.status).toBe('rejected');
  });
});

describe('identitas-drift (spec 17.2, 17.3)', () => {
  const base = ident({
    categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka pinot noir',
    vintageValue: 2023, vintageStatus: 'vintage', volumeMl: 750,
  });

  it('az arvaltozas NEM modositja az identitasfingerprintet', () => {
    const h1 = identityHash({ identity: base });
    const h2 = identityHash({ identity: { ...base } });
    expect(h1).toBe(h2);
  });

  it('az evjarat valtozasa blokkolja az ar publikalasat', () => {
    const after = { ...base, vintageValue: 2024 };
    const d = detectDrift(base, after);
    expect(d.severity).toBe('significant');
    expect(d.blocksPricePublication).toBe(true);
    expect(d.changedFields).toContain('vintageValue');
  });

  it('a kiszereles valtozasa blokkolja az ar publikalasat', () => {
    const d = detectDrift(base, { ...base, volumeMl: 1500 });
    expect(d.blocksPricePublication).toBe(true);
  });

  it('kizarolag nevvaltozas kozmetikai driftnek szamit', () => {
    const d = detectDrift(base, base, { beforeName: 'Gere Roka 2023', afterName: 'Gere Attila Roka 2023' });
    expect(d.severity).toBe('cosmetic');
    expect(d.blocksPricePublication).toBe(false);
  });

  it('tobb identitasmag egyidejű valtozasa masik termeket jelez', () => {
    const d = detectDrift(base, { ...base, producer: 'Bock', expression: 'ermitage' });
    expect(d.severity).toBe('product_changed');
    expect(d.blocksPricePublication).toBe(true);
  });

  it('az unknown -> ismert atmenet dusitas, nem drift', () => {
    const before = ident({ categoryKey: 'wine', producer: 'Gere Attila', expression: 'roka', volumeMl: 750 });
    const after = { ...before, abvPercent: 13.5 };
    const d = detectDrift(before, after);
    expect(d.severity).toBe('none');
  });
});
