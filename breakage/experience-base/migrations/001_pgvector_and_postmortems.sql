-- Experience base migration 001 — enable pgvector and create the
-- postmortems table.
--
-- Target: native Postgres on the orch VM. pgvector is already
-- installed at the cluster level per system context; this migration
-- just enables it in the breakage database and creates the table.
--
-- Embedding dimensions: 1536 matches Anthropic's text-embedding
-- family. Change alongside the embedder if that assumption changes.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── postmortems ──────────────────────────────────────────────────────
--
-- One row per postmortem. Bootstrap rows loaded from
-- breakage/experience-base/seed/*.yaml on first migrate; additional
-- rows appended by scenario runs and (post-launch) production
-- incident ingestion.

CREATE TABLE IF NOT EXISTS postmortems (
  id                      TEXT PRIMARY KEY,              -- incident_id from the YAML
  scenario_id             TEXT,                          -- NULL for production / seeded
  detected_at             TIMESTAMPTZ NOT NULL,
  final_diagnosis         TEXT NOT NULL,
  primary_category        TEXT NOT NULL,
  secondary_categories    TEXT[] NOT NULL DEFAULT '{}',
  confidence              REAL NOT NULL,
  actions_taken           JSONB NOT NULL,                -- ActionRef[]
  fix_applied             TEXT NOT NULL,
  what_did_not_work       TEXT[] NOT NULL DEFAULT '{}',
  time_to_diagnose_s      INTEGER NOT NULL,
  time_to_fix_s           INTEGER NOT NULL,
  side_effects_observed   TEXT[] NOT NULL DEFAULT '{}',
  retrieval_consulted     TEXT[] NOT NULL DEFAULT '{}',
  retrieval_used          TEXT[] NOT NULL DEFAULT '{}',
  outcome                 TEXT NOT NULL CHECK (outcome IN ('resolved', 'regressed', 'inconclusive')),
  source                  TEXT NOT NULL CHECK (source IN ('incident-log', 'scenario', 'production')),
  embedding               vector(1536),
  raw_yaml                TEXT,                          -- preserve the seed YAML verbatim for auditability
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── indexes ──────────────────────────────────────────────────────────

-- k-NN retrieval uses cosine distance; IVFFlat is fine at scale <1M rows.
-- Revisit with HNSW when the corpus grows past that.
CREATE INDEX IF NOT EXISTS postmortems_embedding_cosine_idx
  ON postmortems USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS postmortems_primary_category_idx
  ON postmortems (primary_category);

CREATE INDEX IF NOT EXISTS postmortems_outcome_idx
  ON postmortems (outcome);

CREATE INDEX IF NOT EXISTS postmortems_source_idx
  ON postmortems (source);

-- Week-4 inverse-guardrail-mining query (§16) filters by outcome and
-- groups by category; covered by the two single-column indexes above.

-- ── notes on dimensions ──────────────────────────────────────────────
-- Embedding dim must match the embedder's output. If you change the
-- embedder family, drop and recreate this column in a new migration
-- rather than editing this one (so historical rows stay coherent
-- with the index).
