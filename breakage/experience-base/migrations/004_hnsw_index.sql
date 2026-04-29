-- 004 — Replace ivfflat with HNSW for the postmortems corpus.
--
-- Why: ivfflat partitions the corpus into `lists` clusters and only
-- probes `ivfflat.probes` of them per query (default 1). For Phase-1
-- corpus sizes (7 seeded + ~150 scenario runs), lists=100 creates
-- one-row-per-list clusters and probes=1 means retrieval returns a
-- random 0-3 subset of near neighbors. Under this failure mode, our
-- Step-4 controlled-delta measurement compared Emily's scores with
-- "retrieval returns random partial results" vs "retrieval returns
-- random garbage from the deterministic embedder" — both arms are
-- effectively noise.
--
-- HNSW has no list/probe trade-off: it always returns the full top-k
-- nearest neighbors regardless of corpus size. Slightly more memory
-- during index build, which is irrelevant at our scale.
--
-- See https://github.com/pgvector/pgvector#hnsw for parameter guidance.
-- m=16, ef_construction=64 are pgvector's recommended defaults for
-- general-purpose use. At our corpus size they're far over-provisioned
-- which is fine — build time is ~seconds.
--
-- Safe to rerun: DROP INDEX IF EXISTS covers the re-migrate case.

DROP INDEX IF EXISTS postmortems_embedding_cosine_idx;

CREATE INDEX postmortems_embedding_cosine_idx
  ON postmortems USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
