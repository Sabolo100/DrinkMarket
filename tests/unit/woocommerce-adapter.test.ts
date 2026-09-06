/**
 * A winehub tanulsaga: rossz adapter -> csendes visszaeses -> fantomar.
 *
 * A bolt `shopify` adapterrel volt konfiguralva, holott WooCommerce. A
 * Shopify-ut ezen a bolton HTML-t ad 404-gyel, tehat a platform-ag soha nem
 * mukodott, es a rendszer szo nelkul visszaesett a HTML olvasasara - ott
 * pedig a szallitasi kuszobot olvasta arkent 3 661 termeken.
 *
 * Ket dolog romolhat el itt csendben, ezert mindkettot rogzitjuk:
 *
 *   1. A NYELVI PARAMETER. A bolt ketnyelvu, es a ket katalogus kulon
 *      termekazonositokat hasznal (1 438 magyar, 1 483 angol). Parameter
 *      nelkul minden bor KETSZER kerulne be, ket kulon URL-en, ugyanabban a
 *      boltban - ez a parositasnal ket egyforma jeloltkent jelenne meg.
 *
 *   2. A MINOR UNIT. A Store API a `currency_minor_unit` szerint skalazott
 *      egesz szamot ad. HUF-nal ez 0, tehat "5000" = 5 000 Ft. A fixen
 *      100-zal osztas 50 Ft-ot csinalna belole.
 */
import { describe, it, expect } from 'vitest';
import type { AdapterContext, FetchResponse, ShopConfig } from '@radovin/contracts';
import { WooCommerceAdapter } from '../../packages/adapters/src/shops/woocommerce.js';

/** Egy termek a valos winehub valaszabol, roviditve. */
const TERMEK = {
  id: 66880,
  name: 'Borbély Rózsakő 2024',
  slug: 'borbely-rozsako-2024-0124huborb0040',
  permalink: 'https://winehub.hu/termek/borbely-rozsako-2024-0124huborb0040/',
  sku: '0124HUBORB0040',
  type: 'simple',
  is_in_stock: true,
  is_purchasable: true,
  prices: {
    price: '5000', regular_price: '5000', sale_price: '5000',
    currency_code: 'HUF', currency_minor_unit: 0,
  },
  images: [], categories: [], attributes: [],
};

function shop(adapterConfig: Record<string, unknown>): ShopConfig {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    key: 'winehub', name: 'Winehub',
    baseUrl: 'https://winehub.hu/', canonicalHost: 'winehub.hu',
    alternateHosts: [], segment: 'wine',
    adapterKey: 'woocommerce', adapterVersion: '2.1.0',
    adapterConfig, discoveryStrategy: 'platform_api', policyDisabled: false,
    crawlPolicy: {
      key: 'gentle', userAgent: null, requestsPerSecond: 1, maxConcurrency: 1,
      requestTimeoutMs: 20000, maxRetries: 2, backoffBaseMs: 500, backoffMaxMs: 5000,
      respectRobots: true, allowBrowser: false, dailyRequestBudget: null,
    },
  };
}

/** Rogziti a megkert URL-eket, es egyetlen oldalnyi terméket ad vissza. */
function ctxFor(adapterConfig: Record<string, unknown>): {
  ctx: AdapterContext; urls: string[];
} {
  const urls: string[] = [];
  const ctx = {
    shop: shop(adapterConfig),
    runId: 'r1', correlationId: 'c1',
    now: () => new Date('2026-09-06T10:00:00Z'),
    count: () => {}, log: () => {},
    limits: { maxPages: 5, maxUrls: 50, maxDurationMs: 10_000 },
    fetch: async (url: string): Promise<FetchResponse> => {
      urls.push(url);
      const first = new URL(url).searchParams.get('page') === '1';
      return {
        ok: true, status: 200, url, finalUrl: url, redirectChain: [],
        headers: first ? { 'x-wp-total': '1438' } : {},
        body: JSON.stringify(first ? [TERMEK] : []),
        contentType: 'application/json', fromCache: false, timingMs: 5,
        guard: { blocked: false, reason: 'ok' },
      };
    },
  } as unknown as AdapterContext;
  return { ctx, urls };
}

describe('WooCommerce Store API', () => {
  it('a beallitott nyelvi parameter minden hivasra rakerul', async () => {
    const { ctx, urls } = ctxFor({ platformApiParams: { lang: 'hu' } });
    await new WooCommerceAdapter().discover(ctx);

    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(new URL(u).searchParams.get('lang')).toBe('hu');
    }
  });

  it('parameter nelkul nem talal ki nyelvet magatol', async () => {
    // Fontos, hogy ez NE alapertelmezes legyen: egy egynyelvu boltnal a
    // `lang=hu` ures katalogust adhatna vissza.
    const { ctx, urls } = ctxFor({});
    await new WooCommerceAdapter().discover(ctx);

    expect(urls.length).toBeGreaterThan(0);
    expect(new URL(urls[0]!).searchParams.has('lang')).toBe(false);
  });

  it('a magyar termekoldal URL-jet es a platform-azonositot viszi', async () => {
    const { ctx } = ctxFor({ platformApiParams: { lang: 'hu' } });
    const res = await new WooCommerceAdapter().discover(ctx);

    const target = res.targets.find((t) => t.platformProductId === '66880');
    expect(target).toBeDefined();
    expect(target!.url).toContain('/termek/borbely-rozsako-2024');
    expect(target!.url).not.toContain('/en/');
  });

  it('a HUF ara 5 000 marad - nem osztjuk 100-zal', async () => {
    const { ctx } = ctxFor({ platformApiParams: { lang: 'hu' } });
    const res = await new WooCommerceAdapter().discover(ctx);

    const listing = res.targets[0]?.inlineListing;
    expect(listing).toBeDefined();
    expect(listing!.price.currentPriceHuf).toBe(5000);
  });

  it('a fantom 15 000 Ft sehol nem jelenik meg', async () => {
    const { ctx } = ctxFor({ platformApiParams: { lang: 'hu' } });
    const res = await new WooCommerceAdapter().discover(ctx);

    for (const t of res.targets) {
      expect(t.inlineListing?.price.currentPriceHuf).not.toBe(15000);
    }
  });
});
