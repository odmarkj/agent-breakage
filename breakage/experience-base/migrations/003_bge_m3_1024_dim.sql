-- Migration 003 — switch embedding column from vector(1536) to
-- vector(1024) to match BAAI/bge-m3 output dimensions served by
-- the Tailscale-network VLLM at 100.87.104.106:8002.
--
-- Per migrations/README.md "dimension change" guidance: drop +
-- recreate the column so existing rows' vectors are discarded
-- cleanly rather than silently mixing dimensions. Re-seed with
-- `npm run seed` after this migration to populate new vectors.
--
-- If you later swap providers to one with a different dim (OpenAI
-- text-embedding-3-small: 1536; text-embedding-3-large: 3072;
-- Voyage voyage-3-large: 1024 or 2048 depending on mode), add a
-- new migration rather than editing this one — historical rows
-- stay coherent with whichever migration produced them.

DROP INDEX IF EXISTS postmortems_embedding_cosine_idx;
ALTER TABLE postmortems DROP COLUMN IF EXISTS embedding;
ALTER TABLE postmortems ADD COLUMN embedding vector(1024);

-- Rebuild the IVFFlat index against the new column.
CREATE INDEX postmortems_embedding_cosine_idx
  ON postmortems USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
