-- ============================================================================
-- 0016  Borászatjelöltek bizonyítéka
--
-- A `producers` tábla üres, és a bor kategóriában a `producer` KÖTELEZŐ mező —
-- amíg üres, egyetlen borpárosítás sem tud sikerülni. A bányászat a korpuszból
-- állít elő jelölteket, de azok emberi jóváhagyás nélkül nem válhatnak
-- éles adattá.
--
-- Ehhez nem kell új tábla: a `producers` már ismeri a `status = 'proposed'`
-- állapotot. Ami hiányzott, az a BIZONYÍTÉK — a jóváhagyó csak akkor tud
-- dönteni, ha látja, mire alapozzuk a javaslatot: hány webshopban, hány
-- terméken fordult elő, és hogyan néznek ki azok a nevek.
-- ============================================================================

ALTER TABLE producers
  ADD COLUMN IF NOT EXISTS evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS candidate_score numeric(6,2),
  ADD COLUMN IF NOT EXISTS proposed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at      timestamptz;

COMMENT ON COLUMN producers.evidence IS
  'Mire alapozzuk a javaslatot: hány terméken és hány webshopban fordult elő, tartalmaz-e termelőnév-jelölőt, és példák a nyers termékneveiből.';
COMMENT ON COLUMN producers.candidate_score IS
  'A bányászat rangsorpontszáma. Csak sorrendet ad, döntést nem.';

-- A jóváhagyó felület ezen a szűrésen dolgozik: kevés sor, gyakori lekérdezés.
CREATE INDEX IF NOT EXISTS producers_proposed_idx
  ON producers (candidate_score DESC NULLS LAST)
  WHERE status = 'proposed';
