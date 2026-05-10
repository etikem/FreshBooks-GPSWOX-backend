import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Periodic prune of stale webhook event rows so the table stays bounded.
 *
 * Hard rule: only prune rows that are BOTH processed AND not failed. A
 * failed row is an operator's audit trail — they need to triage from the
 * Logs page or replay it. Pruning failures silently would hide bugs.
 */
export async function runNotificationCleanupOnce(
  now: Date = new Date(),
): Promise<{ deletedWebhookEvents: number }> {
  const cutoff = new Date(
    now.getTime() - env.WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  const { count } = await prisma.webhookEvent.deleteMany({
    where: {
      processed: true,
      failed: false,
      receivedAt: { lt: cutoff },
    },
  });

  if (count > 0) {
    logger.info(
      { deleted: count, cutoff: cutoff.toISOString() },
      'notification.cleanup.done',
    );
  }
  return { deletedWebhookEvents: count };
}
