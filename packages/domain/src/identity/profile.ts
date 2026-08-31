/**
 * Identitasprofil-feloldas (spec 10.1).
 *
 * Az identitasprofil mondja meg kategoriankent es termekenkent, hogy mely
 * attributumok `required`, `contradiction_only`, `supporting` vagy
 * `not_applicable` szerepuek.
 */
import type {
  ComparisonPolicy, IdentityFieldRole, IdentityProfile,
} from '@radovin/contracts';

export const DEFAULT_IDENTITY_PROFILE: IdentityProfile = {
  required: ['expression', 'volume_ml', 'pack_count'],
  contradiction_only: ['gtin', 'abv_percent', 'edition'],
  supporting: [],
  not_applicable: [],
  vintageSensitive: true,
  gtinResolvesVintage: false,
};

export const DEFAULT_COMPARISON_POLICY: ComparisonPolicy = {
  giftBoxEquivalent: false,
  volumeToleranceMl: 5,
  packMustMatch: true,
  allowedPriceTypes: ['regular', 'sale'],
  freshnessMaxHours: 240,
  requireInStock: false,
};

/** A DB-ben tarolt sema-kulcsok es a belso mezonev-terkep. */
const FIELD_ALIASES: Record<string, string> = {
  volume_ml: 'volumeMl',
  pack_count: 'packCount',
  packaging_type: 'packagingType',
  age_statement_years: 'ageStatementYears',
  vintage_status: 'vintageStatus',
  vintage: 'vintageValue',
  dosage_style: 'dosageStyle',
  cask_finish: 'caskFinish',
  abv_percent: 'abvPercent',
  grape_varieties: 'grapeVarieties',
  // A szotarra feloldott azonositok. A DB-profil a beszelo kulcsot hasznalja,
  // az osszehasonlitas viszont az azonositon dol el.
  wine_style: 'wineStyleId',
  country_code: 'countryCode',
  batch_code: 'batchCode',
  colour: 'colour',
  region: 'region',
  producer: 'producer',
  brand: 'brand',
  expression: 'expression',
  edition: 'edition',
  gtin: 'gtin',
  sweetness: 'sweetness',
  puttony: 'puttony',
  fruit: 'fruit',
  flavour: 'flavour',
  aging: 'aging',
  subcategory: 'subcategory',
  appellation: 'appellation',
  vineyard: 'vineyardId',
  organic: 'organic',
};

export function canonicalFieldName(name: string): string {
  return FIELD_ALIASES[name] ?? name;
}

export class ResolvedIdentityProfile {
  private readonly roles = new Map<string, IdentityFieldRole>();

  constructor(
    public readonly profile: IdentityProfile,
    public readonly policy: ComparisonPolicy,
  ) {
    for (const f of profile.not_applicable) this.roles.set(canonicalFieldName(f), 'not_applicable');
    for (const f of profile.supporting) this.roles.set(canonicalFieldName(f), 'supporting');
    for (const f of profile.contradiction_only) this.roles.set(canonicalFieldName(f), 'contradiction_only');
    // A required a legerosebb, ezert utoljara irja felul.
    for (const f of profile.required) this.roles.set(canonicalFieldName(f), 'required');
  }

  roleOf(field: string): IdentityFieldRole {
    return this.roles.get(canonicalFieldName(field)) ?? 'supporting';
  }

  get requiredFields(): string[] {
    return this.profile.required.map(canonicalFieldName);
  }

  get comparableFields(): string[] {
    const out = new Set<string>();
    for (const [field, role] of this.roles) if (role !== 'not_applicable') out.add(field);
    return [...out];
  }

  isVintageSensitive(): boolean {
    return this.profile.vintageSensitive;
  }

  /** Bornal a GTIN SOHA nem oldja fel az evjaratot (spec 10.2). */
  gtinResolvesVintage(): boolean {
    return this.profile.gtinResolvesVintage;
  }

  autoMatchBlocked(): boolean {
    return this.policy.autoMatchBlocked === true;
  }
}

export interface ProfileSources {
  /** Kategoriaszintu alapertelmezes. */
  categoryProfile?: Partial<IdentityProfile> | null;
  categoryPolicy?: Partial<ComparisonPolicy> | null;
  /** Termekvaltozat-szintu felulirás (auditalt kivetel, spec 3.1). */
  variantProfile?: Partial<IdentityProfile> | null;
  variantPolicy?: Partial<ComparisonPolicy> | null;
}

export function resolveIdentityProfile(sources: ProfileSources): ResolvedIdentityProfile {
  const profile: IdentityProfile = {
    ...DEFAULT_IDENTITY_PROFILE,
    ...(sources.categoryProfile ?? {}),
    ...(sources.variantProfile ?? {}),
  } as IdentityProfile;
  // A tomb mezoket nem "shallow merge"-elni kell, hanem a legspecifikusabbat venni
  profile.required = pickArray(sources.variantProfile?.required, sources.categoryProfile?.required, DEFAULT_IDENTITY_PROFILE.required);
  profile.contradiction_only = pickArray(sources.variantProfile?.contradiction_only, sources.categoryProfile?.contradiction_only, DEFAULT_IDENTITY_PROFILE.contradiction_only);
  profile.supporting = pickArray(sources.variantProfile?.supporting, sources.categoryProfile?.supporting, DEFAULT_IDENTITY_PROFILE.supporting);
  profile.not_applicable = pickArray(sources.variantProfile?.not_applicable, sources.categoryProfile?.not_applicable, DEFAULT_IDENTITY_PROFILE.not_applicable);

  const policy: ComparisonPolicy = {
    ...DEFAULT_COMPARISON_POLICY,
    ...(sources.categoryPolicy ?? {}),
    ...(sources.variantPolicy ?? {}),
  } as ComparisonPolicy;

  return new ResolvedIdentityProfile(profile, policy);
}

function pickArray(...candidates: Array<string[] | undefined>): string[] {
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}
