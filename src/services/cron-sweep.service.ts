import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { evaluateAndApply } from './webhook.service';

/**
 * Daily / hourly sweep for clients whose access window has elapsed.
 *
 * Why: webhooks fire on FreshBooks state changes. If a client's
 * `paidThroughDate` lapses without a new invoice or payment event, no
 * webhook fires and the client stays ACTIVE in our DB even though their
 * paid-through window has passed. This sweep re-evaluates them so the
 * BalanceEngine's "paid-through in the past → BLOCK" rule kicks in.
 *
 * Selection criteria:
 *   - status = ACTIVE
 *   - accessExpiresAt < now  (their stored access window has run out)
 *
 * We chunk through clients in batches and call `evaluateAndApply`, which
 * refetches FreshBooks and applies the strict rules. Errors on individual
 * clients don't abort the sweep.
 */
export async function runCronSweepOnce(now: Date = new Date()): Promise<{
  examined: number;
  blocked: number;
  restored: number;
  errors: number;
}> {
  const due = await prisma.client.findMany({
    where: {
      status: 'ACTIVE',
      accessExpiresAt: { lt: now },
    },
    select: { id: true, email: true },
    take: 500,
  });
  if (due.length === 0) {
    return { examined: 0, blocked: 0, restored: 0, errors: 0 };
  }

  logger.info({ n: due.length }, 'cron.sweep.start');

  let blocked = 0;
  let restored = 0;
  let errors = 0;

  for (const c of due) {
    try {
      await evaluateAndApply({ clientId: c.id, trigger: 'CRON' });
      // Read back the new status to count outcomes for the operator log.
      const after = await prisma.client.findUnique({
        where: { id: c.id },
        select: { status: true },
      });
      if (after?.status === 'BLOCKED') blocked += 1;
      else if (after?.status === 'ACTIVE') restored += 1;
    } catch (err) {
      errors += 1;
      logger.warn(
        { clientId: c.id, err: (err as Error).message },
        'cron.sweep.client.failed',
      );
    }
  }

  logger.info(
    { examined: due.length, blocked, restored, errors },
    'cron.sweep.done',
  );
  return { examined: due.length, blocked, restored, errors };
}
