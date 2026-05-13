/**
 * One-shot backfill: find every ABC Track user our system previously set to
 * active=0 and flip them back to active=1. Access is now controlled solely
 * by expiration_date — this script undoes all past active=0 writes without
 * touching any expiration dates.
 *
 * Run with: npm run backfill:restore-active   (from the backend/ directory)
 *
 * Safe to re-run. Only fires a PUT for users actually found to be active=0.
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { abctrackService } from '../services/abctrack.service';
import { login as abctrackLogin } from '../services/abctrack-session';

async function main(): Promise<void> {
  await abctrackLogin();

  const clients = await prisma.client.findMany({
    where: { gpswoxUserId: { not: null } },
    select: { id: true, email: true, gpswoxUserId: true, status: true },
  });

  logger.info({ total: clients.length }, 'restore-active.start');

  let checked = 0;
  let skipped = 0;
  let restored = 0;
  let failed = 0;

  for (const client of clients) {
    if (!client.gpswoxUserId) continue;
    checked += 1;

    let atUser: { active: number } | null = null;
    try {
      atUser = await abctrackService.findUserByEmail(client.email);
    } catch (err) {
      logger.warn(
        { clientId: client.id, email: client.email, err: (err as Error).message },
        'restore-active.lookup-failed',
      );
      failed += 1;
      continue;
    }

    if (!atUser) {
      logger.warn(
        { clientId: client.id, email: client.email },
        'restore-active.not-found-in-abctrack',
      );
      skipped += 1;
      continue;
    }

    if (atUser.active !== 0) {
      skipped += 1;
      continue;
    }

    // User is active=0 — flip to active=1 without touching expiration_date.
    try {
      await abctrackService.enable({
        clientId: client.id,
        gpswoxUserId: client.gpswoxUserId,
        accessExpiresAt: null,
        email: client.email,
      });
      logger.info(
        { clientId: client.id, email: client.email, gpswoxUserId: client.gpswoxUserId },
        'restore-active.restored',
      );
      restored += 1;
    } catch (err) {
      logger.error(
        { clientId: client.id, email: client.email, err: (err as Error).message },
        'restore-active.enable-failed',
      );
      failed += 1;
    }
  }

  logger.info({ checked, restored, skipped, failed }, 'restore-active.done');
}

main()
  .catch((err) => {
    logger.error({ err: err?.message ?? err, stack: err?.stack }, 'restore-active.fatal');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
