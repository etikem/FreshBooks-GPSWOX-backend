-- AlterTable: add detailed FreshBooks client profile fields populated by
-- ensureClientFromFreshbooks() on client.create / client.update webhooks.
ALTER TABLE "clients"
  ADD COLUMN "firstName"       TEXT,
  ADD COLUMN "lastName"        TEXT,
  ADD COLUMN "organization"    TEXT,
  ADD COLUMN "businessPhone"   TEXT,
  ADD COLUMN "mobilePhone"     TEXT,
  ADD COLUMN "homePhone"       TEXT,
  ADD COLUMN "addressStreet"   TEXT,
  ADD COLUMN "addressStreet2"  TEXT,
  ADD COLUMN "addressCity"     TEXT,
  ADD COLUMN "addressProvince" TEXT,
  ADD COLUMN "addressCountry"  TEXT,
  ADD COLUMN "addressCode"     TEXT,
  ADD COLUMN "currencyCode"    TEXT,
  ADD COLUMN "language"        TEXT,
  ADD COLUMN "vatName"         TEXT,
  ADD COLUMN "vatNumber"       TEXT,
  ADD COLUMN "notes"           TEXT;
