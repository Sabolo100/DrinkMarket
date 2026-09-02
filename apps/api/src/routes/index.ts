import type { FastifyInstance } from 'fastify';
import { query } from '@radovin/db';
import { REASON_CODE_HU } from '@radovin/contracts';
import type { AppConfig } from '../config.js';
import { authRoutes } from './auth.js';
import { productRoutes } from './products.js';
import { shopRoutes } from './shops.js';
import { reviewRoutes } from './review.js';
import { dashboardRoutes } from './dashboard.js';
import { importRoutes } from './imports.js';
import { settingsRoutes } from './settings.js';
import { searchRoutes } from './search.js';
import { producerRoutes } from './producers.js';

export async function registerRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(async (api) => {
    // ── Egeszsegellenorzes (nyilvanos) ────────────────────────────────────
    api.get('/health', async () => ({
      status: 'ok',
      service: 'radovin-price-intelligence-api',
      version: '2.1.0',
      time: new Date().toISOString(),
    }));

    api.get('/ready', async (_req, reply) => {
      try {
        await query('SELECT 1');
        return { status: 'ready', database: 'ok' };
      } catch (err) {
        return reply.code(503).send({
          status: 'not_ready',
          database: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    /** A UI ebbol forditja a reason code-okat es a statuszokat magyarra. */
    api.get('/reference/labels', async () => ({
      reasonCodes: REASON_CODE_HU,
      matchStatus: {
        unsearched: 'Meg nem keresve',
        searching: 'Keresés folyamatban',
        candidate_found: 'Van jelölt',
        needs_review: 'Ellenőrzés szükséges',
        auto_verified: 'Automatikusan igazolt',
        human_verified: 'Ember által igazolt',
        rejected: 'Elutasítva',
        ambiguous: 'Több egyforma jelölt',
        insufficient_evidence: 'Nem bizonyítható',
        not_found_after_full_search: 'Teljes keresés után nincs találat',
        source_unhealthy: 'Forrás technikai hiba',
        mapping_drift: 'Identitás-eltolódás',
        listing_missing: 'A listing eltűnt',
        suspended: 'Felfüggesztve',
        search_incomplete: 'A keresés nem futott le teljesen',
      },
      sourceStatus: {
        ok: 'Rendben', partial: 'Részleges', blocked: 'Blokkolva',
        rate_limited: 'Sebességkorlátozva', timeout: 'Időtúllépés',
        unavailable: 'Nem elérhető', parse_error: 'Feldolgozási hiba',
        catalog_regression: 'Katalógus-visszaesés', policy_disabled: 'Policy szerint tiltva',
      },
      packagingType: {
        unknown: 'Ismeretlen', standard: 'Normál palack', gift_box: 'Díszdoboz',
        wooden_case: 'Fadoboz', carton: 'Karton', tube: 'Tubus', set: 'Szett', tin: 'Fémdoboz',
      },
      priceType: {
        regular: 'Normál ár', sale: 'Akciós ár', member: 'Klubár',
        coupon: 'Kuponos ár', quantity: 'Mennyiségi ár',
        unknown: 'Ismeretlen', not_comparable: 'Nem összehasonlítható',
      },
      healthStatus: {
        unknown: 'Ismeretlen', ok: 'Egészséges', degraded: 'Romló',
        failing: 'Hibás', blocked: 'Blokkolt', disabled: 'Kikapcsolva',
      },
    }));

    await authRoutes(api, config);
    await searchRoutes(api, config);
    await productRoutes(api, config);
    await shopRoutes(api, config);
    await reviewRoutes(api, config);
    await dashboardRoutes(api, config);
    await importRoutes(api, config);
    await settingsRoutes(api, config);
    await producerRoutes(api, config);
  }, { prefix: '/api/v1' });
}
