-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ActionKind" AS ENUM ('DECISION_BLOCK', 'DECISION_RESTORE', 'GPSWOX_ENABLE', 'GPSWOX_DISABLE', 'GPSWOX_UPDATE_EXPIRATION', 'ERROR', 'MANUAL_SYNC');

-- CreateEnum
CREATE TYPE "RetryStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('WEBHOOK', 'MANUAL', 'CRON', 'RETRY');

-- CreateEnum
CREATE TYPE "SyncOutcome" AS ENUM ('RESTORED', 'BLOCKED', 'NO_CHANGE', 'ERROR');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "freshbooksAccountId" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "freshbooksClientId" TEXT NOT NULL,
    "gpswoxUserId" TEXT,
    "contractStartDate" TIMESTAMP(3) NOT NULL,
    "contractEndDate" TIMESTAMP(3) NOT NULL,
    "paidThroughDate" TIMESTAMP(3),
    "accessExpiresAt" TIMESTAMP(3),
    "status" "ClientStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastOutstanding" DECIMAL(14,2),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "signature" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "failureReason" TEXT,
    "syncRunId" TEXT,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_cache" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "freshbooksInvoiceId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid" DECIMAL(14,2) NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "issuedDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_logs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "freshbooksPaymentId" TEXT,
    "invoiceId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_logs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "kind" "ActionKind" NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retry_jobs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "RetryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "succeededAt" TIMESTAMP(3),

    CONSTRAINT "retry_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "trigger" "SyncTrigger" NOT NULL,
    "outcome" "SyncOutcome",
    "outstanding" DECIMAL(14,2),
    "paidThroughDate" TIMESTAMP(3),
    "notes" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clients_email_idx" ON "clients"("email");

-- CreateIndex
CREATE INDEX "clients_status_idx" ON "clients"("status");

-- CreateIndex
CREATE UNIQUE INDEX "clients_tenantId_freshbooksClientId_key" ON "clients"("tenantId", "freshbooksClientId");

-- CreateIndex
CREATE INDEX "webhook_events_processed_receivedAt_idx" ON "webhook_events"("processed", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_source_eventId_key" ON "webhook_events"("source", "eventId");

-- CreateIndex
CREATE INDEX "invoice_cache_clientId_dueDate_idx" ON "invoice_cache"("clientId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_cache_clientId_freshbooksInvoiceId_key" ON "invoice_cache"("clientId", "freshbooksInvoiceId");

-- CreateIndex
CREATE INDEX "payment_logs_clientId_paidAt_idx" ON "payment_logs"("clientId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "action_logs_idempotencyKey_key" ON "action_logs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "action_logs_clientId_createdAt_idx" ON "action_logs"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "action_logs_kind_createdAt_idx" ON "action_logs"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "retry_jobs_status_nextAttemptAt_idx" ON "retry_jobs"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "retry_jobs_clientId_status_idx" ON "retry_jobs"("clientId", "status");

-- CreateIndex
CREATE INDEX "sync_runs_clientId_startedAt_idx" ON "sync_runs"("clientId", "startedAt");

-- CreateIndex
CREATE INDEX "sync_runs_outcome_startedAt_idx" ON "sync_runs"("outcome", "startedAt");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_cache" ADD CONSTRAINT "invoice_cache_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_logs" ADD CONSTRAINT "payment_logs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_logs" ADD CONSTRAINT "action_logs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retry_jobs" ADD CONSTRAINT "retry_jobs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
