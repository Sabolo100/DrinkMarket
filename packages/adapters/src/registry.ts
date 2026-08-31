/**
 * Adapter-regiszter. Uj webshop hozzaadhato a kozponti parosito es a frontend
 * atirasa nelkul (spec 1., 2.2).
 */
import type { ShopAdapter } from '@radovin/contracts';
import { genericJsonLdAdapter, browserJsonLdAdapter } from './shops/generic-jsonld.js';
import { wooCommerceAdapter } from './shops/woocommerce.js';
import { shopifyAdapter } from './shops/shopify.js';

const REGISTRY = new Map<string, ShopAdapter>();

export function registerAdapter(adapter: ShopAdapter): void {
  REGISTRY.set(adapter.key, adapter);
}

registerAdapter(genericJsonLdAdapter);
registerAdapter(browserJsonLdAdapter);
registerAdapter(wooCommerceAdapter);
registerAdapter(shopifyAdapter);

export function getAdapter(key: string): ShopAdapter {
  const adapter = REGISTRY.get(key);
  if (!adapter) {
    throw new Error(
      `Ismeretlen adapter: "${key}". Elerheto adapterek: ${[...REGISTRY.keys()].join(', ')}`,
    );
  }
  return adapter;
}

export function hasAdapter(key: string): boolean {
  return REGISTRY.has(key);
}

export function listAdapters(): Array<{ key: string; version: string; capabilities: ShopAdapter['capabilities'] }> {
  return [...REGISTRY.values()].map((a) => ({
    key: a.key, version: a.version, capabilities: a.capabilities,
  }));
}
