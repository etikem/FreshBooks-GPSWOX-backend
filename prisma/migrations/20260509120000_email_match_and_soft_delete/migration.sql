-- Email-based GPSWOX matching + soft-delete invoice cache.
--
-- Postgres requires ALTER TYPE ... ADD VALUE to run outside a transaction.
-- Prisma's migrate runner handles this when the statement is the only one of
-- its kind, but to be defensive we annotate with IF NOT EXISTS so reapplying
-- a partially-rolled migration is safe.

ALTER TYPE "ClientStatus" ADD VALUE IF NOT EXISTS 'NO_MATCHING_GPSWOX_USER';
ALTER TYPE "ActionKind" ADD VALUE IF NOT EXISTS 'GPSWOX_MATCHED';

-- Soft-delete columns. Defaults preserve the behaviour of every row that
-- existed before this migration (active=true, voidedAt=null).
ALTER TABLE "invoice_cache"
  ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "invoice_cache_clientId_active_idx"
  ON "invoice_cache"("clientId", "active");
