import { env } from '../config/env';
import { logger } from '../utils/logger';
import { pollAndRunOnce } from '../services/retry.service';
import { prisma } from '../db/prisma';

let stopping = false;

// Recognises transient pool/socket errors that are recovered by reconnecting.
// Seen in the wild: machine sleep, Postgres restart, NAT idle timeout.
// Prisma's Rust engine surfaces these with varied wording, so we match a
// broad set of substrings rather than relying on error codes.
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
    msg.includes('P1017') // Prisma "Server has closed the connection."
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
        // Drop the stale pool; the next iteration's query will auto-reconnect.
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

// Connect once at boot so misconfigured DATABASE_URLs fail loud right away
// instead of looking like an idle drop on the first poll.
prisma
  .$connect()
  .then(() => {
    logger.info('retry.worker.started');
    return loop();
  })
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'retry.worker.fatal');
    process.exit(1);
  });
