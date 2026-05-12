-- Payment-driven access: replaces the invoice-balance model with one
-- driven by the most recent successful payment. The legacy columns
-- (paid_through_date, last_outstanding) are kept for historical display
-- but no longer written.

ALTER TABLE "clients"
  ADD COLUMN "isUnlimited" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastPaymentAt" TIMESTAMP(3);

-- Backfill lastPaymentAt from existing PaymentLog rows so the cron sweep
-- doesn't falsely block clients on its first pass post-deploy. The
-- backfill-payment-log script reconciles against FreshBooks afterwards.
UPDATE "clients" c
SET "lastPaymentAt" = sub.max_paid_at
FROM (
  SELECT "clientId", MAX("paidAt") AS max_paid_at
  FROM "payment_logs"
  WHERE "paidAt" IS NOT NULL
  GROUP BY "clientId"
) AS sub
WHERE c.id = sub."clientId";

CREATE INDEX "clients_isUnlimited_idx" ON "clients"("isUnlimited");
CREATE INDEX "clients_lastPaymentAt_idx" ON "clients"("lastPaymentAt");
