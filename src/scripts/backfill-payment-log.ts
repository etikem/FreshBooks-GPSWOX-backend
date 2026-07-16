/**
 * One-shot backfill: pull every client's payments from FreshBooks and
 * insert them into the local `payment_logs` table. Then recompute
 * `Client.lastPaymentAt` from MAX(paidAt).
 *
 * Run with: npm run backfill:payments   (from backend/)
 *
 * When: once after the payment-driven-access migration is applied and
 * before traffic resumes. Without this, clients who paid via the legacy
 * invoice-driven engine but never had a PaymentLog row written will be
 * BLOCKED on the first cron sweep post-deploy.
 *
 * Idempotent — skips payments already present (matched by
 * (clientId, freshbooksPaymentId)), so it's safe to invoke repeatedly.
 * Transient FreshBooks failures fall through to the next client rather
 * than aborting the whole run.
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { freshbooksService } from '../services/freshbooks.service';
import { loadTokens as loadFreshbooksTokens } from '../services/freshbooks-token.service';
import { computeEffectivePaidAt } from '../services/webhook.service';

/**
 * Mirror MAX(effectivePaidAt) — the back-dating-adjusted date — onto
 * Client.lastPaymentAt, which the access engine reads.
 */
async function recomputeLastPaymentAt(clientId: string): Promise<void> {
  const latest = await prisma.paymentLog.findFirst({
    where: { clientId, effectivePaidAt: { not: null } },
    orderBy: { effectivePaidAt: 'desc' },
    select: { effectivePaidAt: true },
  });
  await prisma.client.update({
    where: { id: clientId },
    data: { lastPaymentAt: latest?.effectivePaidAt ?? null },
  });
}

async function main(): Promise<void> {
  await loadFreshbooksTokens();

  const clients = await prisma.client.findMany({
    select: { id: true, freshbooksClientId: true, email: true },
    orderBy: { createdAt: 'asc' },
  });
  logger.info({ n: clients.length }, 'backfill.payments.start');

  let scanned = 0;
  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  let touchedClients = 0;

  for (const c of clients) {
    scanned += 1;
    try {
      const payments = await freshbooksService.listPaymentsForClient(
        c.freshbooksClientId,
      );
      if (payments.length === 0) {
        // Still recompute lastPaymentAt — covers the case where every
        // payment was deleted in FreshBooks since the last sync.
        await recomputeLastPaymentAt(c.id);
        touchedClients += 1;
        continue;
      }

      for (const p of payments) {
        const existing = await prisma.paymentLog.findFirst({
          where: { clientId: c.id, freshbooksPaymentId: p.id },
          select: { id: true },
        });
        if (existing) {
          skipped += 1;
          continue;
        }
        const effectivePaidAt = await computeEffectivePaidAt({
          paidAt: p.paidAt,
          invoiceId: p.invoiceId,
        });
        await prisma.paymentLog.create({
          data: {
            clientId: c.id,
            freshbooksPaymentId: p.id,
            invoiceId: p.invoiceId,
            amount: p.amount?.toFixed(2) ?? '0.00',
            currency: p.currency,
            paidAt: p.paidAt,
            effectivePaidAt,
            source: 'backfill',
            rawPayload: p.raw as object,
          },
        });
        inserted += 1;
      }

      await recomputeLastPaymentAt(c.id);
      touchedClients += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        {
          clientId: c.id,
          freshbooksClientId: c.freshbooksClientId,
          err: (err as Error).message,
        },
        'backfill.payments.client.failed',
      );
    }

    if (scanned % 25 === 0) {
      logger.info(
        { scanned, inserted, skipped, failed },
        'backfill.payments.progress',
      );
    }
  }

  logger.info(
    { scanned, inserted, skipped, failed, touchedClients },
    'backfill.payments.done',
  );
}

main()
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'backfill.payments.fatal');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
