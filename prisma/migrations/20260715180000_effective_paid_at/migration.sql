-- Back-dating-safe access window.
--
-- Problem: FreshBooks payments can be back-dated (payment.date set to when
-- funds arrived) even though they settle an invoice for a LATER period. The
-- access engine keyed off payment.date alone, so an end-of-month payment that
-- pays a next-month invoice granted a too-short access window (see the Jeremy
-- Coenraad / invoice 011937 case: paid 2026-06-30, invoice dated 2026-07-01,
-- wrongly expired 2026-07-10 instead of 2026-08-10).
--
-- Fix: store an `effectivePaidAt` = MAX(payment.date, linked invoice date).
-- `paidAt` is preserved as the true audit date; `effectivePaidAt` is what the
-- decision engine consumes (mirrored onto clients.lastPaymentAt).
--
-- Also promotes the payment/date columns to timestamptz to remove a latent
-- timezone-naive risk (harmless today because the app runs in UTC, but the
-- asymmetry with the timestamptz oauth_tokens columns was a footgun).

ALTER TABLE "payment_logs"
  ADD COLUMN "effectivePaidAt" TIMESTAMPTZ(3);

-- Promote existing datetime columns to timestamptz. Existing values were
-- written as UTC wall-clock (app + DB both UTC), so a plain type change
-- preserves the instant.
ALTER TABLE "payment_logs"
  ALTER COLUMN "paidAt" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "effectivePaidAt" TYPE TIMESTAMPTZ(3);

ALTER TABLE "clients"
  ALTER COLUMN "lastPaymentAt" TYPE TIMESTAMPTZ(3);

-- Seed effectivePaidAt = paidAt for all existing rows. The backfill script
-- (npm run backfill:effective-paid-at) then recomputes it against linked
-- invoice dates and re-applies access. Seeding to paidAt first guarantees the
-- column is never NULL where paidAt is set, so lastPaymentAt logic is stable
-- even before the backfill runs.
UPDATE "payment_logs"
SET "effectivePaidAt" = "paidAt"
WHERE "paidAt" IS NOT NULL;

CREATE INDEX "payment_logs_clientId_effectivePaidAt_idx"
  ON "payment_logs"("clientId", "effectivePaidAt");
