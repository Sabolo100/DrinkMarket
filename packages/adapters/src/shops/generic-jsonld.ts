/**
 * Altalanos, JSON-LD alapu adapter (spec 11.2/3-6).
 *
 * Ez az alapertelmezes minden olyan webshopra, ahol nincs nyilvanos platform
 * API, de van XML sitemap es szabvanyos Product/Offer JSON-LD. A BaseAdapter
 * discovery + extraction logikajat hasznalja valtoztatas nelkul.
 *
 * Ha egy forras sem sitemapot, sem JSON-LD-t nem ad, a discovery kategoriaoldal
 * bejarasra esik vissza, es a futas `partial` statusszal zar - SOHA nem
 * `not_found` eredmennyel (spec 38/10).
 */
import type { ShopAdapter } from '@radovin/contracts';
import { BaseAdapter } from '../common/base.js';

export class GenericJsonLdAdapter extends BaseAdapter {
  key = 'generic-jsonld';
  version = '2.1.0';
  capabilities = {
    feed: false, platformApi: false, sitemap: true,
    categoryPages: true, internalSearch: true, requiresBrowser: false,
  };
}

export const genericJsonLdAdapter: ShopAdapter = new GenericJsonLdAdapter();

/**
 * Bongeszos valtozat azokhoz a forrasokhoz, ahol a termekadat kizarolag
 * kliensoldali rendereles utan erheto el. Csak vegso megoldas (spec 38/9),
 * kulon, alacsony konkurencian futo workerben.
 */
export class BrowserJsonLdAdapter extends BaseAdapter {
  key = 'browser-jsonld';
  version = '2.1.0';
  capabilities = {
    feed: false, platformApi: false, sitemap: true,
    categoryPages: true, internalSearch: true, requiresBrowser: true,
  };

  protected override config(ctx: Parameters<BaseAdapter['healthCheck']>[0]) {
    return { forceBrowser: true, ...super.config(ctx) };
  }
}

export const browserJsonLdAdapter: ShopAdapter = new BrowserJsonLdAdapter();
