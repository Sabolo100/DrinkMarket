/**
 * Import wizard (spec 9.1 - 9.3, 21.2).
 *
 * Lepesek: feltoltes -> oszlop-hozzarendeles -> validalas es elonezet ->
 * duplikacio-ellenorzes -> admin jovahagyas -> commit + azonnali keresesi job.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { execute, query, queryOne, transaction } from '@radovin/db';
import {
  extractIdentity, identityHash, parseVolume, parsePackaging, parseVintage,
  parseAgeStatement, searchNorm,
} from '@radovin/domain';
import { AppError } from '@radovin/observability';
import type { AppConfig } from '../config.js';
import { requireAtLeast } from '../lib/auth.js';
import { audit, loadTaxonomy, pageParams, paginated } from '../lib/context.js';
import { parseCsv, parseXlsx } from '../lib/export.js';
import { enqueue, JOB_PRIORITY } from '../lib/queues.js';

/** A wizard altal felismert celmezok. */
export const IMPORT_FIELDS = [
  { key: 'name', label: 'Terméknév', required: true, hints: ['nev', 'név', 'termek', 'termék', 'megnevezes', 'name', 'product', 'title'] },
  { key: 'url', label: 'Webshop termék URL', required: false, hints: ['url', 'link', 'cim', 'cím', 'termeklink'] },
  { key: 'brand', label: 'Márka', required: false, hints: ['marka', 'márka', 'brand', 'gyarto', 'gyártó'] },
  { key: 'producer', label: 'Borászat / termelő', required: false, hints: ['boraszat', 'borászat', 'termelo', 'termelő', 'pinceszet', 'pincészet', 'producer', 'winery'] },
  { key: 'category', label: 'Kategória', required: false, hints: ['kategoria', 'kategória', 'category', 'tipus', 'típus', 'fajta'] },
  { key: 'vintage', label: 'Évjárat', required: false, hints: ['evjarat', 'évjárat', 'vintage', 'ev', 'év', 'year'] },
  { key: 'volume', label: 'Kiszerelés', required: false, hints: ['kiszereles', 'kiszerelés', 'urtartalom', 'űrtartalom', 'volume', 'meret', 'méret', 'size'] },
  { key: 'packCount', label: 'Darabszám', required: false, hints: ['darab', 'db', 'mennyiseg', 'mennyiség', 'pack'] },
  { key: 'packaging', label: 'Csomagolás', required: false, hints: ['csomagolas', 'csomagolás', 'packaging', 'doboz'] },
  { key: 'gtin', label: 'EAN / GTIN', required: false, hints: ['ean', 'gtin', 'vonalkod', 'vonalkód', 'barcode'] },
  { key: 'sku', label: 'Cikkszám / SKU', required: false, hints: ['sku', 'cikkszam', 'cikkszám', 'cikksz'] },
  { key: 'price', label: 'Ár', required: false, hints: ['ar', 'ár', 'price', 'brutto', 'bruttó'] },
  { key: 'shop', label: 'Webshop', required: false, hints: ['webshop', 'shop', 'bolt', 'forras', 'forrás'] },
  { key: 'abv', label: 'Alkoholtartalom', required: false, hints: ['alkohol', 'abv', 'alc'] },
  { key: 'edition', label: 'Kiadás / edition', required: false, hints: ['kiadas', 'kiadás', 'edition', 'expression'] },
  { key: 'track', label: 'Figyelőlistára', required: false, hints: ['figyeles', 'figyelés', 'track', 'kiemelt'] },
] as const;

type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];

export async function importRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  // ── 1. Feltoltes ─────────────────────────────────────────────────────────
  app.post('/products/import', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const file = await req.file();
    if (!file) throw new AppError('NO_FILE', 'Nem erkezett fajl.', 400);

    const buffer = await file.toBuffer();
    if (buffer.length === 0) throw new AppError('EMPTY_FILE', 'A fajl ures.', 400);
    if (buffer.length > 25 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE', 'A fajl tul nagy (max 25 MB).', 400);

    const filename = file.filename ?? 'import';
    const isXlsx = /\.xlsx$/i.test(filename) || buffer.subarray(0, 2).toString('binary') === 'PK';

    let rows: Array<Record<string, string>>;
    try {
      rows = isXlsx ? parseXlsx(buffer) : parseCsv(buffer.toString('utf8'));
    } catch (err) {
      throw new AppError(
        'PARSE_FAILED',
        `A fajl nem olvashato: ${err instanceof Error ? err.message : String(err)}`,
        400,
      );
    }
    if (!rows.length) throw new AppError('NO_ROWS', 'A fajl nem tartalmaz adatsorokat.', 400);
    if (rows.length > 50_000) throw new AppError('TOO_MANY_ROWS', 'Legfeljebb 50 000 sor importalhato egyszerre.', 400);

    const headers = Object.keys(rows[0] ?? {});
    const suggestedMapping = suggestMapping(headers);

    const batch = await queryOne<{ id: string }>(
      `INSERT INTO import_batches (filename, source_kind, status, total_rows, uploaded_by, column_mapping)
       VALUES ($1, $2, 'mapping', $3, $4, $5) RETURNING id`,
      [filename, isXlsx ? 'xlsx' : 'csv', rows.length, actor.id, JSON.stringify(suggestedMapping)],
    );

    await transaction(async (client) => {
      const chunk = 500;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        slice.forEach((row, idx) => {
          const base = values.length;
          values.push(batch!.id, i + idx + 1, JSON.stringify(row));
          placeholders.push(`($${base + 1},$${base + 2},$${base + 3})`);
        });
        await client.query(
          `INSERT INTO import_rows (batch_id, row_number, raw) VALUES ${placeholders.join(',')}`,
          values,
        );
      }
    });

    await audit({
      actorUserId: actor.id, action: 'import.uploaded', entityType: 'import_batch',
      entityId: batch!.id, summary: `${filename}: ${rows.length} sor`, correlationId: req.correlationId,
    });

    return {
      batchId: batch!.id,
      filename,
      totalRows: rows.length,
      headers,
      suggestedMapping,
      availableFields: IMPORT_FIELDS,
      sample: rows.slice(0, 5),
    };
  });

  // ── 2. Oszlop-hozzarendeles es validalas ─────────────────────────────────
  app.post('/products/import/:batchId/validate', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { batchId } = z.object({ batchId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      mapping: z.record(z.string()),
      defaultCategory: z.string().optional(),
      trackAll: z.boolean().default(false),
    }).parse(req.body);

    const batch = await queryOne<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId]);
    if (!batch) throw new AppError('NOT_FOUND', 'Az import batch nem talalhato.', 404);
    if (batch.status === 'committed') throw new AppError('ALREADY_COMMITTED', 'Ez a batch mar veglegesitve lett.', 409);

    const taxonomy = await loadTaxonomy();
    const rows = await query<{ id: string; row_number: number; raw: Record<string, string> }>(
      'SELECT id, row_number, raw FROM import_rows WHERE batch_id = $1 ORDER BY row_number', [batchId],
    );

    const seenKeys = new Map<string, number>();
    let valid = 0; let warnings = 0; let errors = 0; let duplicates = 0;

    await execute('UPDATE import_batches SET status = $2 WHERE id = $1', [batchId, 'validating']);

    for (const row of rows) {
      const messages: Array<{ level: 'error' | 'warning' | 'info'; text: string }> = [];
      const get = (field: ImportFieldKey): string => {
        const column = body.mapping[field];
        return column ? (row.raw[column] ?? '').trim() : '';
      };

      const name = get('name');
      const url = get('url');
      if (!name && !url) {
        messages.push({ level: 'error', text: 'Legalabb a terméknév vagy egy webshop termék-URL kotelezo (spec 9.2).' });
      }

      // Kategoria
      const categoryRaw = get('category') || body.defaultCategory || '';
      const category = categoryRaw ? taxonomy.resolveCategory(categoryRaw) : null;
      if (categoryRaw && !category) {
        messages.push({ level: 'warning', text: `Ismeretlen kategoria: "${categoryRaw}". Besorolatlanként kerul be.` });
      }
      if (!categoryRaw) {
        messages.push({ level: 'warning', text: 'Nincs kategoria - a besorolatlan termek NEM kaphat automatikus parositast.' });
      }

      // Attributumkinyeres a nevbol, bizonyitekkal (spec 9.4)
      const identity = extractIdentity({
        name: name || url,
        specs: {
          ...(get('volume') ? { Kiszereles: get('volume') } : {}),
          ...(get('abv') ? { Alkoholtartalom: get('abv') } : {}),
          ...(get('gtin') ? { EAN: get('gtin') } : {}),
        },
        structured: {
          ...(get('gtin') ? { gtin: get('gtin') } : {}),
          ...(get('sku') ? { sku: get('sku') } : {}),
        },
        categoryPath: categoryRaw ? [categoryRaw] : [],
        brandHint: get('brand') || get('producer') || null,
        resolveBrand: (t) => {
          const hit = taxonomy.resolveBrand(t);
          return hit ? { id: hit.id, canonicalName: hit.canonicalName, producerId: hit.producerId ?? null } : null;
        },
        resolveProducer: (t) => {
          const hit = taxonomy.resolveProducer(t);
          return hit ? { id: hit.id, canonicalName: hit.canonicalName } : null;
        },
        resolveCategory: (t) => taxonomy.resolveCategory(t),
      });

      // Explicit oszlopok felulirjak a nevbol kinyertet
      const explicitVintage = get('vintage');
      if (explicitVintage) {
        const parsed = parseVintage(explicitVintage, 'structured');
        if (parsed.value) { identity.identity.vintageValue = parsed.value; identity.identity.vintageStatus = 'vintage'; }
        else if (parsed.status === 'non_vintage') identity.identity.vintageStatus = 'non_vintage';
        else messages.push({ level: 'warning', text: `Az evjarat oszlop erteke nem ertelmezheto: "${explicitVintage}".` });
      }
      const explicitVolume = get('volume');
      if (explicitVolume) {
        const parsed = parseVolume(explicitVolume);
        if (parsed.unitVolumeMl) identity.identity.volumeMl = parsed.unitVolumeMl;
        if (parsed.packCount > 1) identity.identity.packCount = parsed.packCount;
      }
      const explicitPack = Number.parseInt(get('packCount'), 10);
      if (Number.isFinite(explicitPack) && explicitPack > 0) identity.identity.packCount = explicitPack;
      const explicitPackaging = get('packaging');
      if (explicitPackaging) {
        const parsed = parsePackaging(explicitPackaging);
        if (parsed.packagingType !== 'unknown') identity.identity.packagingType = parsed.packagingType;
      }
      const explicitEdition = get('edition');
      if (explicitEdition) identity.identity.edition = explicitEdition;
      if (!identity.identity.ageStatementYears) {
        const age = parseAgeStatement(name);
        if (age.years) identity.identity.ageStatementYears = age.years;
      }
      if (category) identity.identity.categoryKey = category.key;

      for (const w of identity.warnings) messages.push({ level: 'warning', text: w });

      // Hianyzo identitasmezok jelzese (spec 5.1/5)
      if (!identity.identity.volumeMl) {
        messages.push({ level: 'warning', text: 'A kiszereles nem allapithato meg - kotelezo mezo, kezi kiegeszites szukseges.' });
      }
      if (identity.identity.vintageStatus === 'unknown' &&
          ['wine', 'sparkling_wine', 'champagne', 'tokaji_aszu'].includes(identity.identity.categoryKey ?? '')) {
        messages.push({ level: 'warning', text: 'Az evjarat nem bizonyitott - bornal ez kotelezo azonossagi mezo.' });
      }

      // Duplikacio a fajlon belul
      const dedupeKey = [
        searchNorm(identity.identity.producer ?? identity.identity.brand ?? ''),
        searchNorm(identity.identity.expression ?? name),
        identity.identity.vintageValue ?? '-',
        identity.identity.volumeMl ?? '-',
        identity.identity.packCount,
        identity.identity.packagingType,
      ].join('|');
      const previous = seenKeys.get(dedupeKey);
      let status: 'valid' | 'warning' | 'error' | 'duplicate' = 'valid';
      if (previous !== undefined) {
        status = 'duplicate';
        messages.push({ level: 'error', text: `Duplikatum a fajlon belul (${previous}. sor).` });
      } else {
        seenKeys.set(dedupeKey, row.row_number);
      }

      // Duplikacio a meglevo katalogusban
      let duplicateOf: string | null = null;
      if (status !== 'duplicate' && identity.identity.volumeMl) {
        const existing = await queryOne<{ id: string; canonical_display_name: string }>(
          `SELECT cv.id, cv.canonical_display_name
             FROM canonical_variants cv
             JOIN product_families pf ON pf.id = cv.product_family_id
            WHERE cv.status = 'active'
              AND cv.volume_ml = $1 AND cv.pack_count = $2
              AND coalesce(cv.vintage_value, -1) = coalesce($3::int, -1)
              AND rv_search_norm(pf.canonical_name) = rv_search_norm($4)
            LIMIT 1`,
          [identity.identity.volumeMl, identity.identity.packCount,
            identity.identity.vintageValue, identity.identity.expression ?? name],
        );
        if (existing) {
          duplicateOf = existing.id;
          messages.push({ level: 'warning', text: `Mar letezik hasonlo kanonikus valtozat: "${existing.canonical_display_name}". Osszevonasi javaslat.` });
        }
      }

      if (messages.some((m) => m.level === 'error')) status = status === 'duplicate' ? 'duplicate' : 'error';
      else if (messages.some((m) => m.level === 'warning')) status = 'warning';

      if (status === 'valid') valid++;
      else if (status === 'warning') warnings++;
      else if (status === 'duplicate') duplicates++;
      else errors++;

      await execute(
        `UPDATE import_rows
            SET parsed = $2, extracted_evidence = $3, status = $4, messages = $5, duplicate_of = $6
          WHERE id = $1`,
        [
          row.id,
          JSON.stringify({
            name: name || url,
            url: url || null,
            price: get('price') || null,
            shop: get('shop') || null,
            track: body.trackAll || /^(1|igen|yes|true|x)$/i.test(get('track')),
            categoryKey: identity.identity.categoryKey ?? 'uncategorized',
            identity: identity.identity,
          }),
          JSON.stringify(identity.evidence),
          status, JSON.stringify(messages), duplicateOf,
        ],
      );
    }

    await execute(
      `UPDATE import_batches
          SET status = 'validated', column_mapping = $2, options = $3,
              valid_rows = $4, warning_rows = $5, error_rows = $6, duplicate_rows = $7
        WHERE id = $1`,
      [
        batchId, JSON.stringify(body.mapping),
        JSON.stringify({ defaultCategory: body.defaultCategory, trackAll: body.trackAll }),
        valid, warnings, errors, duplicates,
      ],
    );

    await audit({
      actorUserId: actor.id, action: 'import.validated', entityType: 'import_batch', entityId: batchId,
      summary: `${valid} ervenyes, ${warnings} figyelmeztetes, ${errors} hiba, ${duplicates} duplikatum`,
      correlationId: req.correlationId,
    });

    return { batchId, valid, warnings, errors, duplicates, total: rows.length };
  });

  // ── Elonezet ─────────────────────────────────────────────────────────────
  app.get('/products/import/:batchId', async (req) => {
    const { batchId } = z.object({ batchId: z.string().uuid() }).parse(req.params);
    const q = z.object({
      status: z.string().optional(),
      page: z.coerce.number().optional(),
      pageSize: z.coerce.number().optional(),
    }).parse(req.query);
    const p = pageParams(q as Record<string, unknown>);

    const batch = await queryOne('SELECT * FROM import_batches WHERE id = $1', [batchId]);
    if (!batch) throw new AppError('NOT_FOUND', 'Az import batch nem talalhato.', 404);

    const where = ['batch_id = $1'];
    const params: unknown[] = [batchId];
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [items, countRow] = await Promise.all([
      query(
        `SELECT id, row_number, raw, parsed, status, messages, duplicate_of, created_variant_id
           FROM import_rows ${whereSql} ORDER BY row_number
          LIMIT ${p.pageSize} OFFSET ${p.offset}`,
        params,
      ),
      queryOne<{ total: number }>(`SELECT count(*)::int AS total FROM import_rows ${whereSql}`, params),
    ]);
    return { batch, ...paginated(items, countRow?.total ?? 0, p) };
  });

  // ── 3. Commit ────────────────────────────────────────────────────────────
  app.post('/products/import/:batchId/commit', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { batchId } = z.object({ batchId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      includeWarnings: z.boolean().default(true),
      skipDuplicates: z.boolean().default(true),
    }).parse(req.body ?? {});

    const batch = await queryOne<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId]);
    if (!batch) throw new AppError('NOT_FOUND', 'Az import batch nem talalhato.', 404);
    if (batch.status !== 'validated') {
      throw new AppError('NOT_VALIDATED', 'A batchet elobb validalni kell.', 409);
    }

    const statuses = body.includeWarnings ? ['valid', 'warning'] : ['valid'];
    const rows = await query<{
      id: string; parsed: Record<string, unknown>; extracted_evidence: unknown; duplicate_of: string | null;
    }>(
      `SELECT id, parsed, extracted_evidence, duplicate_of
         FROM import_rows WHERE batch_id = $1 AND status = ANY($2::text[]) ORDER BY row_number`,
      [batchId, statuses],
    );

    await execute(`UPDATE import_batches SET status = 'committing' WHERE id = $1`, [batchId]);

    let createdVariants = 0; let createdFamilies = 0; let createdTracked = 0; let skipped = 0;
    const createdIds: string[] = [];

    for (const row of rows) {
      if (row.duplicate_of && body.skipDuplicates) { skipped++; continue; }
      const parsed = row.parsed as {
        name: string; url: string | null; track: boolean; categoryKey: string;
        identity: Record<string, unknown>;
      };
      const identity = parsed.identity;

      try {
        const created = await transaction(async (client) => {
          const cat = await client.query<{ id: string; identity_profile: unknown; comparison_policy: unknown }>(
            'SELECT id, identity_profile, comparison_policy FROM product_categories WHERE key = $1',
            [parsed.categoryKey || 'uncategorized'],
          );
          const category = cat.rows[0];
          if (!category) throw new Error(`Ismeretlen kategoria: ${parsed.categoryKey}`);

          const producerId = identity['producer']
            ? await upsertNamed(client, 'producers', String(identity['producer'])) : null;
          const brandId = identity['brand']
            ? await upsertNamed(client, 'brands', String(identity['brand'])) : null;

          const familyName = String(identity['expression'] ?? parsed.name);
          const existingFamily = await client.query<{ id: string }>(
            `SELECT id FROM product_families
              WHERE category_id = $1 AND rv_search_norm(canonical_name) = rv_search_norm($2)
                AND coalesce(producer_id::text,'') = coalesce($3::text,'')
                AND status <> 'merged' LIMIT 1`,
            [category.id, familyName, producerId],
          );
          const familyId = existingFamily.rows[0]?.id ?? (await client.query<{ id: string }>(
            `INSERT INTO product_families
               (category_id, producer_id, brand_id, canonical_name, status, created_by)
             VALUES ($1,$2,$3,$4,'active',$5) RETURNING id`,
            [category.id, producerId, brandId, familyName, actor.id],
          )).rows[0]!.id;
          if (!existingFamily.rows[0]) createdFamilies++;

          const variant = await client.query<{ id: string }>(
            `INSERT INTO canonical_variants
               (product_family_id, canonical_display_name, vintage_value, vintage_status,
                age_statement_years, volume_ml, pack_count, packaging_type, edition,
                puttony, dosage_style, abv_percent, gtin, gtin_normalized,
                identity_profile_json, comparison_policy_json, evidence, identity_hash,
                status, origin, created_by, approved_by, approved_at, import_batch_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                     $19,'import',$20,$20, now(), $21)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              familyId, parsed.name,
              identity['vintageValue'] ?? null, identity['vintageStatus'] ?? 'unknown',
              identity['ageStatementYears'] ?? null, identity['volumeMl'] ?? null,
              identity['packCount'] ?? 1, identity['packagingType'] ?? 'unknown',
              identity['edition'] ?? null, identity['puttony'] ?? null,
              identity['dosageStyle'] ?? null, identity['abvPercent'] ?? null,
              identity['gtin'] ?? null,
              identity['gtin'] ? String(identity['gtin']).replace(/\D/g, '') : null,
              JSON.stringify(category.identity_profile), JSON.stringify(category.comparison_policy),
              JSON.stringify(row.extracted_evidence ?? {}),
              identityHash({ identity: identity as never }),
              // Hianyos identitas -> proposed allapot (spec 8.3)
              identity['volumeMl'] ? 'active' : 'proposed',
              actor.id, batchId,
            ],
          );
          const variantId = variant.rows[0]?.id;
          if (!variantId) return null;

          if (parsed.track) {
            await client.query(
              `INSERT INTO tracked_products
                 (canonical_variant_id, tracking_origin, import_batch_id, approved_by, approved_at)
               VALUES ($1,'import',$2,$3, now()) ON CONFLICT DO NOTHING`,
              [variantId, batchId, actor.id],
            );
            createdTracked++;
          }

          // Azonnali kereses minden aktiv webshopban (spec 5.1/7)
          await client.query(
            `INSERT INTO variant_shop_status (canonical_variant_id, shop_id, status, next_search_at)
             SELECT $1, id, 'unsearched', now() FROM shops WHERE active AND NOT policy_disabled
             ON CONFLICT DO NOTHING`,
            [variantId],
          );
          await client.query(
            `UPDATE import_rows SET status = 'committed', created_variant_id = $2 WHERE id = $1`,
            [row.id, variantId],
          );
          return variantId;
        });

        if (created) { createdVariants++; createdIds.push(created); }
        else skipped++;
      } catch (err) {
        await execute(
          `UPDATE import_rows
              SET status = 'error',
                  messages = messages || $2::jsonb
            WHERE id = $1`,
          [row.id, JSON.stringify([{ level: 'error', text: `Commit hiba: ${err instanceof Error ? err.message : String(err)}` }])],
        );
      }
    }

    await execute(
      `UPDATE import_batches
          SET status = 'committed', committed_by = $2, committed_at = now(),
              created_variants = $3, created_families = $4, created_tracked = $5
        WHERE id = $1`,
      [batchId, actor.id, createdVariants, createdFamilies, createdTracked],
    );

    // Kereses inditasa kotegelten
    for (const id of createdIds) {
      await enqueue({
        redisUrl: config.REDIS_URL, queue: 'candidate-generation', name: 'search-all-shops',
        payload: { canonicalVariantId: id, trigger: 'import' },
        idempotencyKey: `search:${id}:import`,
        priority: JOB_PRIORITY['manual-search'], correlationId: req.correlationId,
      }).catch(() => undefined);
    }

    await audit({
      actorUserId: actor.id, action: 'import.committed', entityType: 'import_batch', entityId: batchId,
      summary: `${createdVariants} kanonikus valtozat, ${createdFamilies} termekcsalad, ${createdTracked} figyelt`,
      correlationId: req.correlationId,
    });

    return { batchId, createdVariants, createdFamilies, createdTracked, skipped, searchQueued: createdIds.length };
  });

  app.get('/products/imports', async (req) => {
    requireAtLeast(req.user, 'catalog_manager');
    const p = pageParams(req.query as Record<string, unknown>, 25);
    const [items, countRow] = await Promise.all([
      query(
        `SELECT b.*, u.display_name AS uploaded_by_name
           FROM import_batches b LEFT JOIN users u ON u.id = b.uploaded_by
          ORDER BY b.created_at DESC LIMIT ${p.pageSize} OFFSET ${p.offset}`,
      ),
      queryOne<{ total: number }>('SELECT count(*)::int AS total FROM import_batches'),
    ]);
    return paginated(items, countRow?.total ?? 0, p);
  });

  app.delete('/products/import/:batchId', async (req) => {
    const actor = requireAtLeast(req.user, 'catalog_manager');
    const { batchId } = z.object({ batchId: z.string().uuid() }).parse(req.params);
    const batch = await queryOne<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batchId]);
    if (!batch) throw new AppError('NOT_FOUND', 'Az import batch nem talalhato.', 404);
    if (batch.status === 'committed') {
      throw new AppError('ALREADY_COMMITTED', 'Veglegesitett import nem torolheto. A letrejott termekek kulon kezelendok.', 409);
    }
    await execute(`UPDATE import_batches SET status = 'cancelled' WHERE id = $1`, [batchId]);
    await audit({
      actorUserId: actor.id, action: 'import.cancelled', entityType: 'import_batch', entityId: batchId,
      correlationId: req.correlationId,
    });
    return { ok: true };
  });
}

function suggestMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const field of IMPORT_FIELDS) {
    for (const header of headers) {
      if (used.has(header)) continue;
      const norm = searchNorm(header);
      if (field.hints.some((h) => norm === searchNorm(h) || norm.includes(searchNorm(h)))) {
        mapping[field.key] = header;
        used.add(header);
        break;
      }
    }
  }
  return mapping;
}

async function upsertNamed(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }> },
  table: 'producers' | 'brands',
  name: string,
): Promise<string> {
  const existing = await client.query(
    `SELECT id FROM ${table} WHERE name_norm = rv_search_norm($1) AND status <> 'merged' LIMIT 1`,
    [name],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await client.query(
    `INSERT INTO ${table} (canonical_name, status) VALUES ($1, 'active') RETURNING id`, [name],
  );
  return created.rows[0]!.id;
}
