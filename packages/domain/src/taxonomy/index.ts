/**
 * Taxonomia-feloldas: kategoria, marka, termelo es alias-resolver epitok.
 * Spec 13.3, 8.10.
 *
 * Lepcsok (spec 13.3):
 *   1. exact canonical name
 *   2. jovahagyott alias
 *   3. webshop-specifikus alias
 *   4. normalizalt irasmod
 *   5. typo/fuzzy javaslat - CSAK review celra
 *   6. AI-javaslat - CSAK review celra
 *
 * Fuzzy egyezes NEM hozhat letre automatikusan uj markaazonossagot.
 */
import { searchNorm, nameSimilarity, levenshteinRatio } from '../normalization/text.js';

export interface TaxonomyEntity {
  id: string;
  canonicalName: string;
  nameNorm: string;
  producerId?: string | null;
  categoryId?: string | null;
  fuzzyBlocked: boolean;
}

export interface AliasEntry {
  aliasType: 'brand' | 'producer' | 'expression' | 'unit' | 'packaging' | 'category';
  aliasNorm: string;
  targetKind: string;
  targetId: string | null;
  targetLiteral: string | null;
  shopId: string | null;
  approved: boolean;
}

export interface CategoryEntry {
  id: string;
  key: string;
  nameNorm: string;
  aliases: string[];
}

export interface TaxonomySnapshot {
  brands: TaxonomyEntity[];
  producers: TaxonomyEntity[];
  categories: CategoryEntry[];
  aliases: AliasEntry[];
  negativeAliases: Array<{ leftNorm: string; rightNorm: string; categoryKey: string | null; reason: string }>;
  identityTerms: Array<{ termNorm: string; termClass: string; categoryKey: string | null }>;
  version: string;
}

export interface ResolveHit {
  id: string;
  canonicalName: string;
  producerId?: string | null;
  via: 'exact' | 'alias' | 'shop_alias' | 'normalized';
}

/**
 * Kategoriak, amik FELULIRJAK a tobbit a feloldasnal.
 *
 * A pezsgo, a champagne es az aszu magasabb rendu megkulonboztetes, mint a
 * szin vagy a fajta: ha a szoveg barhol kimondja oket, az dont. A sorrend
 * kozottuk nem szamit, mert egy szovegben egyszerre nem fordulnak elo -
 * es ha megis, a `champagne` a szukebb, tehat azt a leghosszabb-alias
 * szabaly amugy is elore hozna.
 */
const OVERRIDING_CATEGORIES = new Set(['champagne', 'sparkling_wine', 'tokaji_aszu']);

export class Taxonomy {
  private readonly brandByNorm = new Map<string, TaxonomyEntity>();
  private readonly producerByNorm = new Map<string, TaxonomyEntity>();
  private readonly brandById = new Map<string, TaxonomyEntity>();
  private readonly producerById = new Map<string, TaxonomyEntity>();
  private readonly categoryByAlias = new Map<string, CategoryEntry>();
  private readonly aliasIndex = new Map<string, AliasEntry[]>();
  private readonly negativeIndex = new Map<string, Array<{ other: string; categoryKey: string | null; reason: string }>>();
  private readonly identityTermSet = new Set<string>();

  constructor(public readonly snapshot: TaxonomySnapshot) {
    for (const b of snapshot.brands) {
      this.brandByNorm.set(b.nameNorm, b);
      this.brandById.set(b.id, b);
    }
    for (const p of snapshot.producers) {
      this.producerByNorm.set(p.nameNorm, p);
      this.producerById.set(p.id, p);
    }
    for (const c of snapshot.categories) {
      this.categoryByAlias.set(c.nameNorm, c);
      for (const a of c.aliases) this.categoryByAlias.set(searchNorm(a), c);
      this.categoryByAlias.set(searchNorm(c.key), c);
    }
    for (const a of snapshot.aliases) {
      if (!a.approved) continue;
      const key = `${a.aliasType}:${a.aliasNorm}`;
      const list = this.aliasIndex.get(key) ?? [];
      list.push(a);
      this.aliasIndex.set(key, list);
    }
    for (const n of snapshot.negativeAliases) {
      pushMap(this.negativeIndex, n.leftNorm, { other: n.rightNorm, categoryKey: n.categoryKey, reason: n.reason });
      pushMap(this.negativeIndex, n.rightNorm, { other: n.leftNorm, categoryKey: n.categoryKey, reason: n.reason });
    }
    for (const t of snapshot.identityTerms) this.identityTermSet.add(t.termNorm);
  }

  /** Marka feloldasa. Fuzzy NEM ad automatikus talalatot. */
  resolveBrand(text: string, shopId?: string): ResolveHit | null {
    return this.resolveEntity('brand', text, this.brandByNorm, this.brandById, shopId);
  }

  resolveProducer(text: string, shopId?: string): ResolveHit | null {
    return this.resolveEntity('producer', text, this.producerByNorm, this.producerById, shopId);
  }

  private resolveEntity(
    type: 'brand' | 'producer',
    text: string,
    byNorm: Map<string, TaxonomyEntity>,
    byId: Map<string, TaxonomyEntity>,
    shopId?: string,
  ): ResolveHit | null {
    const norm = searchNorm(text);
    if (!norm) return null;

    // 1. Exact canonical name
    const exact = byNorm.get(norm);
    if (exact) return { id: exact.id, canonicalName: exact.canonicalName, producerId: exact.producerId, via: 'exact' };

    // 2-3. Alias (globalis, majd webshop-specifikus)
    const aliases = this.aliasIndex.get(`${type}:${norm}`) ?? [];
    const global = aliases.find((a) => a.shopId === null);
    const shopSpecific = shopId ? aliases.find((a) => a.shopId === shopId) : undefined;
    const chosen = global ?? shopSpecific;
    if (chosen?.targetId) {
      const target = byId.get(chosen.targetId);
      if (target) {
        return {
          id: target.id, canonicalName: target.canonicalName, producerId: target.producerId,
          via: chosen.shopId ? 'shop_alias' : 'alias',
        };
      }
    }

    // 4. A nevben szereplo leghosszabb ismert entitas (prefix-egyezes)
    let best: TaxonomyEntity | null = null;
    for (const [entNorm, ent] of byNorm) {
      if (entNorm.length < 4) continue;
      if (norm === entNorm || norm.startsWith(`${entNorm} `) || norm.includes(` ${entNorm} `) || norm.endsWith(` ${entNorm}`)) {
        if (!best || entNorm.length > best.nameNorm.length) best = ent;
      }
    }
    if (best) return { id: best.id, canonicalName: best.canonicalName, producerId: best.producerId, via: 'normalized' };

    // 5-6. Fuzzy: SOHA nem ad automatikus talalatot. Csak javaslat.
    return null;
  }

  /**
   * Fuzzy javaslatok CSAK review celra (spec 13.3/5). Az eredmeny nem
   * hasznalhato automatikus dontesre.
   */
  suggestBrands(text: string, limit = 5): Array<{ id: string; canonicalName: string; similarity: number; fuzzyBlocked: boolean }> {
    const norm = searchNorm(text);
    if (!norm) return [];
    const scored: Array<{ id: string; canonicalName: string; similarity: number; fuzzyBlocked: boolean }> = [];
    for (const b of this.snapshot.brands) {
      const sim = Math.max(nameSimilarity(norm, b.nameNorm), levenshteinRatio(norm, b.nameNorm));
      if (sim >= 0.6) scored.push({ id: b.id, canonicalName: b.canonicalName, similarity: Math.round(sim * 1000) / 1000, fuzzyBlocked: b.fuzzyBlocked });
    }
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  /**
   * Kategoria feloldasa egy morzsaut-elembol vagy egy terméknévbol.
   *
   * A reszszo-keres korabban az ELSO talalatot adta vissza, a Map beszurasi
   * sorrendjeben. Ez nem semleges sorrend: a seedben a `wine` aliaszai
   * (koztuk a `rose`) ELOBB allnak, mint a `sparkling_wine` aliaszai. Egy
   * "Rose pezsgo" szovegbol ezert BOR lett, nem pezsgo.
   *
   * A hiba sulyat az adta meg, hogy a kategoria idokozben KEMENY kizaro
   * jelle valt: a rossz besorolas mar nem csak pontot von, hanem nemán
   * kizar - vagy eppen hamis egyezest ad.
   *
   * Ket szabaly dont, ebben a sorrendben:
   *
   *   1. A magasabb rendu ital-tipus felulir. Ha a szoveg BARHOL azt mondja,
   *      hogy pezsgo (vagy champagne, aszu), akkor az a kategoria - meg
   *      akkor is, ha mellette ott all a "rose" vagy egy szolofajta.
   *   2. Egyebkent a LEGHOSSZABB illeszkedo alias nyer, mert az a
   *      legspecifikusabb ("tokaji aszu" > "aszu", "pezsgo champagne" >
   *      "pezsgo").
   */
  resolveCategory(text: string): { key: string; id: string } | null {
    const norm = searchNorm(text);
    if (!norm) return null;
    const direct = this.categoryByAlias.get(norm);
    if (direct) return { key: direct.key, id: direct.id };

    const hits: Array<{ key: string; id: string; alias: string }> = [];
    for (const [aliasNorm, cat] of this.categoryByAlias) {
      if (!aliasNorm || aliasNorm.length < 3) continue;
      if (norm === aliasNorm
        || norm.includes(` ${aliasNorm} `)
        || norm.startsWith(`${aliasNorm} `)
        || norm.endsWith(` ${aliasNorm}`)) {
        hits.push({ key: cat.key, id: cat.id, alias: aliasNorm });
      }
    }
    if (!hits.length) return null;

    const override = hits.find((h) => OVERRIDING_CATEGORIES.has(h.key));
    if (override) return { key: override.key, id: override.id };

    hits.sort((a, b) => b.alias.length - a.alias.length || a.key.localeCompare(b.key));
    return { key: hits[0]!.key, id: hits[0]!.id };
  }

  /** Alias-resolver a comparator szamara. */
  aliasResolver = (
    type: 'brand' | 'producer' | 'expression',
    text: string,
    shopId?: string,
  ): { targetId?: string; targetLiteral?: string; shopSpecific: boolean } | null => {
    const norm = searchNorm(text);
    const entries = this.aliasIndex.get(`${type}:${norm}`) ?? [];
    if (!entries.length) {
      if (type === 'brand') {
        const hit = this.brandByNorm.get(norm);
        if (hit) return { targetId: hit.id, shopSpecific: false };
      }
      if (type === 'producer') {
        const hit = this.producerByNorm.get(norm);
        if (hit) return { targetId: hit.id, shopSpecific: false };
      }
      return null;
    }
    const global = entries.find((e) => e.shopId === null);
    const shopEntry = shopId ? entries.find((e) => e.shopId === shopId) : undefined;
    const chosen = global ?? shopEntry;
    if (!chosen) return null;
    return {
      targetId: chosen.targetId ?? undefined,
      targetLiteral: chosen.targetLiteral ?? undefined,
      shopSpecific: chosen.shopId !== null,
    };
  };

  /** Negativ alias ellenorzes: bizonyitottan NEM azonos termekvonalak. */
  negativeAliasCheck = (a: string, b: string, categoryKey: string | null): string | null => {
    const na = searchNorm(a);
    const nb = searchNorm(b);
    if (!na || !nb || na === nb) return null;
    for (const key of [na, nb]) {
      const entries = this.negativeIndex.get(key) ?? [];
      for (const e of entries) {
        if (e.categoryKey && categoryKey && e.categoryKey !== categoryKey) continue;
        const other = key === na ? nb : na;
        if (other === e.other) return e.reason;
      }
    }
    // Reszszo alapu ellenorzes: pl. "johnnie walker black label" vs "... double black"
    for (const [term, entries] of this.negativeIndex) {
      if (term.length < 4) continue;
      const inA = na.includes(term);
      const inB = nb.includes(term);
      if (inA === inB) continue;
      for (const e of entries) {
        if (e.categoryKey && categoryKey && e.categoryKey !== categoryKey) continue;
        const otherInA = na.includes(e.other);
        const otherInB = nb.includes(e.other);
        if ((inA && otherInB) || (inB && otherInA)) return e.reason;
      }
    }
    return null;
  };

  /** Marka fuzzy-tiltas (szemelynev-alapu pinceszet, rovid marka). */
  isFuzzyBlocked(brandId: string | null | undefined): boolean {
    if (!brandId) return false;
    return this.brandById.get(brandId)?.fuzzyBlocked ?? this.producerById.get(brandId)?.fuzzyBlocked ?? false;
  }

  /** Identitashordozo kifejezes-e? Ha igen, SOHA nem dobhato el zajszokent. */
  isIdentityTerm(token: string): boolean {
    return this.identityTermSet.has(searchNorm(token));
  }
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export function emptyTaxonomy(): Taxonomy {
  return new Taxonomy({
    brands: [], producers: [], categories: [], aliases: [],
    negativeAliases: [], identityTerms: [], version: '0.0.0',
  });
}
