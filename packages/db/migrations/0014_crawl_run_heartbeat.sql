-- ============================================================================
-- 0014  Futás-szívverés és a ragadt futások felismerése
--
-- Egy deploy, egy OOM vagy bármilyen konténerleállás megöli a futó
-- felderítést, a `crawl_runs` sor viszont `running` állapotban marad — nincs,
-- ami lezárja. Ez két bajt okoz:
--
--   1. Az adott webshopra NEM lehet új felderítést indítani: sem kézzel, sem
--      ütemezetten, mert a rendszer futó discoveryt lát rajta.
--   2. Semmilyen riasztás nem keletkezik. A bolt csendben áll — pontosan az a
--      hibaosztály, amit a spec szerint soha nem szabad elrejteni.
--
-- Élesben ez három boltot blokkolt egyszerre; kettő 2,5 órán át "futott",
-- miközben a konténerük már rég nem létezett.
--
-- A megoldás szívverés, nem időkorlát. Az "elmúlt X perc" szabály nem tud
-- különbséget tenni egy hosszan futó, de ÉLŐ futás és egy halott között — egy
-- 3 órás katalógusfutás legitim. A szívverés igen: ha a folyamat él, frissíti;
-- ha meghalt, megáll.
-- ============================================================================

ALTER TABLE crawl_runs
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

COMMENT ON COLUMN crawl_runs.heartbeat_at IS
  'A futó folyamat utolsó életjele. Az ütemező ez alapján ismeri fel a megszakadt futásokat. NULL a régi sorokon.';

-- A meglévő futó sorokra a kezdés az utolsó ismert életjel: így a reaper
-- azonnal fel tudja ismerni a most is ragadt futásokat.
UPDATE crawl_runs SET heartbeat_at = started_at
 WHERE status = 'running' AND heartbeat_at IS NULL;

-- Részleges index: a reaper csak a futó sorokat nézi, azokból pedig kevés van.
CREATE INDEX IF NOT EXISTS crawl_runs_running_heartbeat_idx
  ON crawl_runs (heartbeat_at)
  WHERE status = 'running';
