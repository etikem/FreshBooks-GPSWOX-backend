import { env } from '../config/env';
import { logger } from '../utils/logger';
import { pollAndRunOnce, cancelDeprecatedDisableJobs } from '../services/retry.service';
import { runCronSweepOnce } from '../services/cron-sweep.service';
import { runNotificationCleanupOnce } from '../services/notification-cleanup.service';
import { prisma } from '../db/prisma';

let stopping = false;
let lastCronSweepAt = 0;
let lastCleanupAt = 0;

// Recognises transient pool/socket errors that recover after reconnecting.
// Seen in the wild: machine sleep, Postgres restart, NAT idle timeout, and
// Prisma's initial-connect failure (P1001) when Postgres is briefly down.
function isConnectionError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return (
    msg.includes('Server has closed the connection') ||
    msg.includes('Connection terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('forcibly closed') ||
    msg.includes('ConnectionReset') ||
    msg.includes('kind: Io') ||
    msg.includes('Closed') ||
    msg.includes('connection closed') ||
    msg.includes("Can't reach database server") ||
    msg.includes('P1001') ||
    msg.includes('P1002') ||
    msg.includes('P1017')
  );
}

async function loop(): Promise<void> {
  while (!stopping) {
    try {
      const n = await pollAndRunOnce();
      if (n > 0) logger.info({ n }, 'retry.batch.processed');
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'retry.loop.error');
      if (isConnectionError(err)) {
        try {
          await prisma.$disconnect();
          logger.warn('retry.db.reconnect');
        } catch (disconnectErr) {
          logger.error(
            { err: (disconnectErr as Error).message },
            'retry.db.disconnect-failed',
          );
        }
      }
    }

    // Cron sweep — runs at most once per CRON_SWEEP_INTERVAL_MS. Keeps
    // expired-access clients from drifting between webhooks.
    const now = Date.now();
    if (now - lastCronSweepAt >= env.CRON_SWEEP_INTERVAL_MS) {
      lastCronSweepAt = now;
      runCronSweepOnce().catch((err) =>
        logger.warn({ err: (err as Error).message }, 'cron.sweep.failed'),
      );
    }

    // Notification / webhook-event cleanup. Cheap delete-where; runs daily
    // by default. Failures are non-fatal — table size grows for a day.
    if (now - lastCleanupAt >= env.NOTIFICATION_CLEANUP_INTERVAL_MS) {
      lastCleanupAt = now;
      runNotificationCleanupOnce().catch((err) =>
        logger.warn({ err: (err as Error).message }, 'notification.cleanup.failed'),
      );
    }

    await sleep(env.RETRY_POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'retry.worker.shutdown');
  stopping = true;
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

prisma
  .$connect()
  .then(async () => {
    logger.info(
      { cronSweepIntervalMs: env.CRON_SWEEP_INTERVAL_MS },
      'retry.worker.started',
    );
    // Drain any stale gpswox.disable jobs left over from before
    // auto-disable was removed, so they can't run and suspend a user.
    await cancelDeprecatedDisableJobs().catch((err) =>
      logger.warn(
        { err: (err as Error).message },
        'retry.cancel-deprecated-disable.failed',
      ),
    );
    return loop();
  })
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'retry.worker.fatal');
    process.exit(1);
  });
