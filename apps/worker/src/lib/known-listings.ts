/**
 * Mar ismert listingek indexe a felderiteshez.
 *
 * A felderites feladata UJ termek-URL-ek megtalalasa. A mar ismert termekek
 * arat es keszletet a `known-listing-refresh` sor tartja naprakeszen, az
 * identitas-eltolodast pedig szinten az a folyamat veszi eszre - a
 * felderitesnek nem kell oket ujra letoltenie minden korben.
 *
 * Ez azert szamit, mert a letoltes ritkitott: a `gentle` policy 0,5 keres/mp
 * uteme mellett a 40 perces futasi korlat 1200 kerest jelent. Ha a keret
 * elmegy a mar ismert termekek ujraletoltesere, a katalogus vege soha nem
 * kerul sorra. Egy atugras viszont NEM keres, tehat ingyenes - igy a futas
 * atsuhan az ismert reszen, es a teljes idokeretet uj termekekre kolti.
 *
 * A parositas szandekosan konzervativ: ha nem tudjuk biztosan, hogy a cel egy
 * mar ismert listinghez tartozik, NEM ugrunk. Egy kimarado atugras egyetlen
 * keresbe kerul; egy teves atugras viszont elrejtene egy valodi termeket.
 */
import type { DiscoveredTarget } from '@radovin/contracts';
import { query } from '@radovin/db';

export interface KnownListing {
  id: string;
  /** Mikor sikerult utoljara ertelmesen kinyerni. NULL = meg soha. */
  lastSuccessfulExtractAt: Date | null;
}

export interface KnownListingRow {
  id: string;
  platform_product_id: string | null;
  platform_variant_id: string | null;
  canonical_url: string;
  last_successful_extract_at: Date | null;
}

/** Kisebb irasmodbeli elteresek kiegyenlitese az URL-osszevetesnel. */
function urlVariants(url: string): string[] {
  const trimmed = url.trim();
  const lower = trimmed.toLowerCase();
  const noSlash = lower.endsWith('/') ? lower.slice(0, -1) : lower;
  return [...new Set([trimmed, lower, noSlash])];
}

function platformKey(productId: string | null | undefined, variantId: string | null | undefined): string | null {
  if (!productId) return null;
  return `${productId}|${variantId ?? ''}`;
}

export class KnownListingIndex {
  private readonly byPlatform = new Map<string, KnownListing>();
  private readonly byUrl = new Map<string, KnownListing>();

  constructor(rows: readonly KnownListingRow[], private readonly freshMs: number) {
    for (const row of rows) {
      const entry: KnownListing = {
        id: row.id,
        lastSuccessfulExtractAt: row.last_successful_extract_at,
      };
      const pk = platformKey(row.platform_product_id, row.platform_variant_id);
      if (pk) this.byPlatform.set(pk, entry);
      for (const v of urlVariants(row.canonical_url)) {
        // Utkozes eseten NEM felulirunk: ket listing ugyanarra az URL-re
        // ketertelmuseg, es ott inkabb toltsuk le.
        if (!this.byUrl.has(v)) this.byUrl.set(v, entry);
      }
    }
  }

  get size(): number {
    return this.byUrl.size;
  }

  lookup(target: DiscoveredTarget): KnownListing | null {
    const pk = platformKey(target.platformProductId, target.platformVariantId);
    if (pk) {
      const hit = this.byPlatform.get(pk);
      if (hit) return hit;
    }
    for (const v of urlVariants(target.url)) {
      const hit = this.byUrl.get(v);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Atugorhato-e a cel?
   *
   * Csak akkor, ha van sikeres kinyeres, es az a frissessegi ablakon belul
   * van. A meg soha ki nem nyert listing (lastSuccessfulExtractAt = NULL)
   * SOHA nem ugorhato at - eppen az a listing szorul letoltesre.
   */
  isFresh(known: KnownListing, now = Date.now()): boolean {
    if (!known.lastSuccessfulExtractAt) return false;
    return now - known.lastSuccessfulExtractAt.getTime() < this.freshMs;
  }
}

export async function loadKnownListings(
  shopId: string,
  freshHours: number,
): Promise<KnownListingIndex> {
  const rows = await query<KnownListingRow>(
    `SELECT id::text, platform_product_id, platform_variant_id,
            canonical_url, last_successful_extract_at
       FROM source_listings
      WHERE shop_id = $1 AND listing_status = 'active'`,
    [shopId],
  );
  return new KnownListingIndex(rows, freshHours * 3600_000);
}
