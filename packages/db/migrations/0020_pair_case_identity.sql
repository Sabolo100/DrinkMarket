-- ---------------------------------------------------------------------------
-- 0020 — Egy változat + egy bolt = EGY nyitott eset, a döntés fajtájától
--        függetlenül
--
-- A 0018 az egyediséget a `(case_type, változat, bolt)` hármasra kulcsolta.
-- Ez első ránézésre helyes, valójában viszont pont azt engedte vissza, amit
-- meg akart szüntetni: a `case_type` ugyanis nem a pár azonossága, hanem a
-- DÖNTÉS EREDMÉNYE — `needs_review` esetén `new_match`, döntetlennél
-- `ambiguous`. Ugyanaz a bolt-változat pár tehát futásról futásra hol az
-- egyikbe, hol a másikba esik.
--
-- A következmény a felületen látszott: a Bolyki Cabernet Franc mellett
-- KÉTSZER jelent meg ugyanaz a Bortársaság-tétel, ugyanazzal az árral. Az
-- ember kétszer döntött volna ugyanarról, és a sor magától nőtt.
--
-- A helyes azonosság: egy változatot egy boltban egyszerre EGY nyitott eset
-- képvisel. Hogy a rendszer „új párnak" vagy „döntetlennek" látta-e, az a
-- döntés TARTALMA — az eseté nem.
--
-- A `mapping_drift`, `price_anomaly` és a többi továbbra is külön marad:
-- azok valóban más természetű ügyek ugyanarra a párra.
-- ---------------------------------------------------------------------------

-- A meglévő duplikátumok lezárása: a legfrissebbet tartjuk meg. A régebbi
-- nem törlődik, `dismissed` lesz — a döntés így visszakereshető marad.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY canonical_variant_id, shop_id
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM review_cases
   WHERE status IN ('open', 'in_progress', 'deferred')
     AND case_type IN ('new_match', 'ambiguous')
     AND canonical_variant_id IS NOT NULL
     AND shop_id IS NOT NULL
)
UPDATE review_cases rc
   SET status = 'dismissed',
       resolution = 'auto_resolved',
       resolution_note = 'Ugyanarra a változat+bolt párra két nyitott eset keletkezett, '
                      || 'mert a case_type a döntés eredményétől függött (0020).',
       resolved_at = now(),
       row_version = rc.row_version + 1
  FROM ranked
 WHERE ranked.id = rc.id AND ranked.rn > 1;

DROP INDEX IF EXISTS review_cases_open_pair_uq;

-- A `new_match` és az `ambiguous` EGY vödörbe esik. A kifejezés immutábilis,
-- tehát indexelhető.
CREATE UNIQUE INDEX review_cases_open_pair_uq ON review_cases (
  (CASE WHEN case_type IN ('new_match', 'ambiguous') THEN 'pair_decision'
        ELSE case_type END),
  coalesce(canonical_variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(shop_id,              '00000000-0000-0000-0000-000000000000'::uuid),
  -- A bolt nélküli esetek (pl. mapping_drift egy listingre) továbbra is a
  -- listing szerint egyediek.
  coalesce(CASE WHEN shop_id IS NULL THEN source_listing_id END,
           '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE status IN ('open', 'in_progress', 'deferred');

COMMENT ON INDEX review_cases_open_pair_uq IS
  'Egy változatot egy boltban egyszerre egy nyitott eset képvisel. Hogy a rendszer új párnak vagy döntetlennek látta, az a döntés tartalma — az eseté nem.';
