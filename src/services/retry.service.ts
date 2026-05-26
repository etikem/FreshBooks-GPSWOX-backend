import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { RetryStatus } from '@prisma/client';
import { abctrackService } from './abctrack.service';

export type RetryOperation =
  | 'gpswox.enable'
  | 'gpswox.disable'
  | 'gpswox.updateExpiration';

export interface EnqueueArgs {
  clientId: string;
  operation: RetryOperation;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  // Optional initial error for diagnostics.
  initialError?: string;
}

/**
 * Enqueue a job. We intentionally keep the queue inside Postgres (no Redis
 * dependency) so that:
 *   - one failure mode (DB down) covers everything
 *   - the retry table doubles as an operator dashboard
 *   - replays are trivial (set status=PENDING, nextAttemptAt=now)
 */
export async function enqueueRetry(args: EnqueueArgs): Promise<void> {
  await prisma.retryJob.upsert({
    where: { id: args.idempotencyKey },
    update: {
      status: 'PENDING',
      nextAttemptAt: new Date(),
      lastError: args.initialError ?? null,
    },
    create: {
      id: args.idempotencyKey,
      clientId: args.clientId,
      operation: args.operation,
      payload: args.payload as object,
      idempotencyKey: args.idempotencyKey,
      maxAttempts: env.RETRY_MAX_ATTEMPTS,
      status: 'PENDING',
      nextAttemptAt: new Date(),
      lastError: args.initialError ?? null,
    },
  });
  logger.info(
    { op: args.operation, clientId: args.clientId },
    'retry.enqueued',
  );
}

/**
 * Exponential backoff with jitter. Attempt N waits min(2^N + rand, cap)s.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt, 60 * 60); // cap 1h
  const jitter = Math.floor(Math.random() * 1000);
  return base * 1000 + jitter;
}

/**
 * Pick up due jobs and execute them. Designed to be called from a worker
 * loop. We claim a job by atomically transitioning PENDING → RUNNING with
 * a conditional update so two workers never grab the same row.
 */
export async function pollAndRunOnce(now: Date = new Date()): Promise<number> {
  // Fetch a small batch of due jobs.
  const due = await prisma.retryJob.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: 25,
  });

  let processed = 0;

  for (const job of due) {
    // Try to claim the job atomically.
    const claim = await prisma.retryJob.updateMany({
      where: { id: job.id, status: 'PENDING' },
      data: { status: 'RUNNING', attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue; // another worker grabbed it

    processed += 1;

    try {
      await runJob(job.operation, job.payload as Record<string, unknown>, {
        clientId: job.clientId,
        idempotencyKey: job.idempotencyKey,
      });
      await prisma.retryJob.update({
        where: { id: job.id },
        data: { status: 'SUCCEEDED', succeededAt: new Date(), lastError: null },
      });
      logger.info({ jobId: job.id, op: job.operation }, 'retry.success');
    } catch (err) {
      const message = (err as Error).message;
      const exhausted = job.attempts + 1 >= job.maxAttempts;
      const next = new Date(Date.now() + backoffMs(job.attempts + 1));
      await prisma.retryJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? 'FAILED' : 'PENDING',
          nextAttemptAt: next,
          lastError: message,
        },
      });
      logger.warn(
        { jobId: job.id, op: job.operation, exhausted, err: message },
        'retry.failed-attempt',
      );
    }
  }

  return processed;
}

async function runJob(
  operation: string,
  payload: Record<string, unknown>,
  ctx: { clientId: string; idempotencyKey: string },
): Promise<void> {
  // Abctrack's update validator requires `email`. Prefer the value the
  // webhook captured into the payload at enqueue time; if it isn't there
  // (older retry rows from before this was threaded through), fall back
  // to the current DB email so we still satisfy the validator.
  const email =
    typeof payload.email === 'string' && payload.email
      ? payload.email
      : (await prisma.client.findUnique({
          where: { id: ctx.clientId },
          select: { email: true },
        }))?.email ?? null;

  switch (operation) {
    case 'gpswox.enable':
      await abctrackService.enable({
        clientId: ctx.clientId,
        gpswoxUserId: String(payload.gpswoxUserId),
        accessExpiresAt: new Date(String(payload.accessExpiresAt)),
        email,
      });
      return;
    case 'gpswox.disable':
      // Intentional no-op. Auto-disabling a client in ABC Track is no
      // longer part of the system's behavior — ABC Track is only
      // written on payment (expiration), client.create (full profile),
      // and client.delete (active=0). This case remains only to drain
      // stale jobs from the queue that were enqueued before the rule
      // change. New code never enqueues `gpswox.disable`.
      logger.info(
        { clientId: ctx.clientId, gpswoxUserId: payload.gpswoxUserId },
        'retry.gpswox.disable.skipped-deprecated',
      );
      return;
    case 'gpswox.updateExpiration':
      await abctrackService.updateExpiration({
        clientId: ctx.clientId,
        gpswoxUserId: String(payload.gpswoxUserId),
        accessExpiresAt: new Date(String(payload.accessExpiresAt)),
        email,
      });
      return;
    default:
      throw new Error(`Unknown retry operation: ${operation}`);
  }
}

export async function manualReplay(jobId: string): Promise<void> {
  await prisma.retryJob.update({
    where: { id: jobId },
    data: {
      status: 'PENDING',
      nextAttemptAt: new Date(),
      // Reset attempts so the operator gets a fresh window.
      attempts: 0,
    },
  });
}

export async function cancel(jobId: string): Promise<void> {
  await prisma.retryJob.update({
    where: { id: jobId },
    data: { status: 'CANCELLED' },
  });
}

/**
 * One-shot startup cleanup. Cancels any PENDING `gpswox.disable` retry
 * jobs left over from before auto-disable was removed. Without this, a
 * stale queued job would still call `abctrackService.disable()` and
 * suspend an account when the worker drains the queue.
 *
 * Idempotent — safe to call on every worker boot. Returns the count of
 * jobs cancelled.
 */
export async function cancelDeprecatedDisableJobs(): Promise<number> {
  const result = await prisma.retryJob.updateMany({
    where: { operation: 'gpswox.disable', status: 'PENDING' },
    data: {
      status: 'CANCELLED',
      lastError:
        'Cancelled at boot — gpswox.disable is no longer a valid operation. ABC Track auto-disable was removed.',
    },
  });
  if (result.count > 0) {
    logger.warn(
      { count: result.count },
      'retry.gpswox.disable.cancelled-stale',
    );
  }
  return result.count;
}

export { RetryStatus };
