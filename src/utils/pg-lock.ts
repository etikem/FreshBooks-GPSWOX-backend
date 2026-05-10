import { createHash } from 'crypto';
import { prisma } from '../db/prisma';
import { logger } from './logger';

/**
 * Postgres advisory-lock helper.
 *
 * Why advisory locks (and not Redis)?
 *   - We already depend on Postgres; a Redis dep is one more thing to deploy.
 *   - `pg_advisory_lock` / `pg_advisory_unlock` are session-scoped, fast,
 *     reliable, and atomic. They are the standard Postgres-native primitive
 *     for "make sure only one node does X at a time".
 *   - If you'd rather use Redis, swap `withAdvisoryLock` for a `SET key NX EX`
 *     wrapper — every other module in this codebase stays untouched.
 *
 * IMPORTANT: advisory locks are tied to a Postgres SESSION. Prisma multiplexes
 * across the pool, so a connection handed out for the lock acquisition is NOT
 * guaranteed to be the same connection used by `prisma.foo.find(...)` between
 * lock and unlock. We use `$transaction(... )` so that BOTH the
 * `pg_advisory_xact_lock` AND the work inside `fn` run on the same connection
 * inside one transaction. The "xact" variant releases automatically on COMMIT
 * or ROLLBACK — there is no leak risk if `fn` throws.
 */

/**
 * Convert a string lock name into a stable bigint key for pg_advisory_lock.
 * Uses the first 8 bytes of SHA-256, interpreted as a signed 64-bit integer
 * (Postgres' bigint range). Collisions across unrelated names are vanishingly
 * unlikely for the small number of lock names we use.
 */
export function lockKeyFromName(name: string): bigint {
  const hash = createHash('sha256').update(name).digest();
  // Read first 8 bytes as a signed BigInt (matches PG's bigint).
  const key = hash.readBigInt64BE(0);
  return key;
}

/**
 * Run `fn` while holding a transaction-scoped Postgres advisory lock keyed on
 * `name`. Other callers waiting on the same name will block until this call
 * commits or rolls back.
 *
 * Use this for refresh-token rotation, single-leader cron sweeps, anything
 * that must run at most once cluster-wide.
 *
 * @param name        Stable identifier — same name = same lock.
 * @param fn          Async function executed under the lock. Receives a
 *                    Prisma transactional client — use it for any DB work that
 *                    should ride on the same connection (you almost always
 *                    want to).
 * @param timeoutMs   Soft cap on total time spent inside the transaction.
 *                    Default 30s. Caller should keep `fn` well under this —
 *                    the FreshBooks refresh call itself has a 15s timeout.
 */
export async function withAdvisoryLock<T>(
  name: string,
  fn: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const key = lockKeyFromName(name);
  const start = Date.now();

  return prisma.$transaction(
    async (tx) => {
      // Blocking acquire. If another node holds it, we wait. The transaction
      // timeout below caps that wait so we never hang forever on a stuck peer.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;

      const waited = Date.now() - start;
      if (waited > 100) {
        logger.info({ name, waitedMs: waited }, 'pg_lock.acquired_after_wait');
      }

      return fn(tx);
    },
    { timeout: timeoutMs, maxWait: timeoutMs },
  );
}
