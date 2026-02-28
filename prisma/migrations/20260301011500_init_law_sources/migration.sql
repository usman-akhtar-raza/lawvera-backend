CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "LawSourceStatus" AS ENUM ('active', 'disabled');
CREATE TYPE "IngestionStatus" AS ENUM (
  'uploaded',
  'extracting',
  'embedding',
  'indexing',
  'ready',
  'needs_ocr',
  'failed'
);

CREATE TABLE "LawSource" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" TEXT NOT NULL,
  "edition" TEXT,
  "jurisdiction" TEXT,
  "language" TEXT,
  "status" "LawSourceStatus" NOT NULL DEFAULT 'active',
  "filePath" TEXT NOT NULL,
  "fileHash" TEXT NOT NULL UNIQUE,
  "ingestionStatus" "IngestionStatus" NOT NULL DEFAULT 'uploaded',
  "warningText" TEXT,
  "chunkCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "LawChunk" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sourceId" UUID NOT NULL,
  "chunkText" TEXT NOT NULL,
  "metadataJson" JSONB,
  "embedding" vector(1536),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LawChunk_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "LawSource"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LawSource_status_createdAt_idx"
  ON "LawSource"("status", "createdAt");

CREATE INDEX "LawChunk_sourceId_createdAt_idx"
  ON "LawChunk"("sourceId", "createdAt");

CREATE INDEX "LawChunk_embedding_hnsw_idx"
  ON "LawChunk" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;

CREATE OR REPLACE FUNCTION update_law_source_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_law_source_updated_at
BEFORE UPDATE ON "LawSource"
FOR EACH ROW
EXECUTE FUNCTION update_law_source_updated_at();
