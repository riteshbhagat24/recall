-- Post-migration SQL: things Prisma's schema language can't express.
-- Run AFTER `prisma migrate deploy` via `npm run db:setup`. Idempotent.

-- pgvector extension (also declared in schema.prisma; harmless if already on).
CREATE EXTENSION IF NOT EXISTS vector;

-- Full-text search column on transcript turns (PRD F6 keyword half). Generated
-- + STORED so it stays in sync with `text` automatically. 'simple' config avoids
-- English stemming that would mangle Hindi/Marathi/Hinglish tokens.
ALTER TABLE transcript_turns
  ADD COLUMN IF NOT EXISTS text_search tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED;

CREATE INDEX IF NOT EXISTS transcript_turns_text_search_idx
  ON transcript_turns USING GIN (text_search);

-- Approximate-nearest-neighbour index for semantic search (PRD REQ-10.1).
-- HNSW gives good recall/latency; cosine ops match our 1 - (a <=> b) scoring.
CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_idx
  ON embeddings USING hnsw (embedding vector_cosine_ops);
