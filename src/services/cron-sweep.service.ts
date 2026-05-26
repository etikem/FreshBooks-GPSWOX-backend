import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

/**
 * Daily / hourly sweep for clients whose access window has elapsed.
 *
 * Local-only. ABC Track expiration is written once, at the moment a
 * payment arrives, to the 10th of the following month. When that date
 * passes, ABC Track auto-expires the user on its own — we do NOT need
 * to push another update. This sweep exists only to keep our own
 * `Client.status` field in sync with reality so the admin dashboard's
 * BLOCKED filter is accurate.
 *
 * Selection criteria:
 *   - status = ACTIVE
 *   - isUnlimited = false   (unlimited clients bypass billing entirely)
 *   - accessExpiresAt < now (their stored access window has run out)
 *
 * Unlimited clients are explicitly excluded — they have no expiration
 * and should never be auto-blocked by this sweep.
 *
 * Errors on individual clients don't abort the sweep.
 */
export async function runCronSweepOnce(now: Date = new Date()): Promise<{
  examined: number;
  blocked: number;
  errors: number;
}> {
  const due = await prisma.client.findMany({
    where: {
      status: 'ACTIVE',
      isUnlimited: false,
      accessExpiresAt: { lt: now },
    },
    select: { id: true, tenantId: true, email: true },
    take: 500,
  });
  if (due.length === 0) {
    return { examined: 0, blocked: 0, errors: 0 };
  }

  logger.info({ n: due.length }, 'cron.sweep.start');

  let blocked = 0;
  let errors = 0;

  for (const c of due) {
    try {
      await prisma.$transaction([
        prisma.client.update({
          where: { id: c.id },
          data: {
            status: 'BLOCKED',
            accessExpiresAt: null,
            lastSyncedAt: now,
          },
        }),
        prisma.actionLog.create({
          data: {
            clientId: c.id,
            kind: 'DECISION_BLOCK',
            message:
              'Access window elapsed — local status updated to BLOCKED. ABC Track expiration was written on the last payment and expires the user on its own; no ABC Track call made.',
          },
        }),
        prisma.syncRun.create({
          data: {
            tenantId: c.tenantId,
            clientId: c.id,
            trigger: 'CRON',
            outcome: 'BLOCKED',
            finishedAt: now,
            notes: 'Local-only status update. ABC Track unaffected.',
          },
        }),
      ]);
      blocked += 1;
    } catch (err) {
      errors += 1;
      logger.warn(
        { clientId: c.id, err: (err as Error).message },
        'cron.sweep.client.failed',
      );
    }
  }

  logger.info(
    { examined: due.length, blocked, errors },
    'cron.sweep.done',
  );
  return { examined: due.length, blocked, errors };
}
