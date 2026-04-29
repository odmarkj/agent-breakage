-- Migration 002 — add run_metadata to postmortems.
--
-- For scenario-source postmortems, the orchestrator populates this
-- column with the score + detector observations + retrieval-used
-- derivation. Lets scorecard reports query pass rate, per-category
-- rollup, and retrieval-impact without reconstructing from the
-- scorer logic.
--
-- Shape (scenario-source rows):
-- {
--   "score": { "total": 0.91, "axes": {...} },
--   "detector": { "fixed": true, "regressions": [], "elapsed_ms": 16083 },
--   "retrieval": { "k": 3, "consulted": [...], "used": [] },
--   "ran_at": "2026-04-21T23:14:02.547Z"
-- }
--
-- NULL for incident-log and production-source rows until they
-- acquire observations (if ever).

ALTER TABLE postmortems ADD COLUMN IF NOT EXISTS run_metadata JSONB;

CREATE INDEX IF NOT EXISTS postmortems_run_metadata_score_idx
  ON postmortems ((run_metadata->'score'->>'total'))
  WHERE source = 'scenario';
