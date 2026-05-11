/**
 * One-shot script: trigger a manual sync for every client whose status
 * is currently UNKNOWN. Mirrors the admin "Manual sync" button
 * (controllers/admin.controller.ts → triggerManualSync) so each client
 * gets an ActionLog row + a SyncRun + a fresh BalanceEngine decision.
 *
 * Run with: npm run sync:unknown   (from the backend/ directory)
 *
 * Sequential by design — FreshBooks rate-limits, and the BalanceEngine
 * hits the API per client. Safe to re-run; clients that flipped out of
 * UNKNOWN since the last run are simply skipped.
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { evaluateAndApply } from '../services/webhook.service';
import { loadTokens as loadFreshbooksTokens } from '../services/freshbooks-token.service';

async function main(): Promise<void> {
  await loadFreshbooksTokens();

  const clients = await prisma.client.findMany({
    where: { status: 'UNKNOWN' },
    select: { id: true, email: true, freshbooksClientId: true },
    orderBy: { updatedAt: 'asc' },
  });

  logger.info({ count: clients.length }, 'sync.unknown.start');

  let ok = 0;
  let failed = 0;

  for (const client of clients) {
    try {
      await prisma.actionLog.create({
        data: {
          clientId: client.id,
          kind: 'MANUAL_SYNC',
          message: 'Bulk sync triggered from sync-unknown-clients script',
        },
      });
      await evaluateAndApply({ clientId: client.id, trigger: 'MANUAL' });
      ok += 1;
      logger.info(
        { clientId: client.id, email: client.email },
        'sync.unknown.client.ok',
      );
    } catch (err) {
      failed += 1;
      logger.warn(
        {
          clientId: client.id,
          email: client.email,
          err: err instanceof Error ? err.message : String(err),
        },
        'sync.unknown.client.failed',
      );
    }
  }

  logger.info({ ok, failed, total: clients.length }, 'sync.unknown.done');
}

main()
  .catch((err) => {
    logger.error({ err: err?.message ?? err, stack: err?.stack }, 'sync.unknown.failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
