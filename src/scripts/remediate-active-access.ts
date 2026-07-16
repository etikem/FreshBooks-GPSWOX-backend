/**
 * Remediation: block ACTIVE, non-unlimited clients who do NOT have a
 * qualifying recent payment under the real decideAccess engine.
 *
 * Context: two pre-existing bugs left dormant/unpaid clients ACTIVE — the
 * auto-create path granted access without checking payment, and the cron
 * sweep wasn't blocking lapsed windows. This one-shot corrects the backlog.
 * Going forward the auto-create fix + cron fix keep it enforced.
 *
 * DRY-RUN BY DEFAULT — prints who would be blocked, writes nothing.
 *   npm run remediate:active-access            # dry-run
 *   npm run remediate:active-access -- --apply # live
 *
 * What "block" does (matches the engine's BLOCK path): local status → BLOCKED,
 * accessExpiresAt → null, logs a DECISION_BLOCK action + a CRON SyncRun. It
 * does NOT call ABC Track — ABC Track auto-expires the user when the
 * expiration date it was given passes. So this is a local/dashboard
 * correction, safe and reversible (a future payment re-enables).
 *
 * SKIPS:
 *   - isUnlimited clients (never touched).
 *   - obvious test accounts (email domains/patterns below).
 *   - anyone the engine says RESTORE (they have a current payment) — including
 *     the "paid July but stale expiry" clients, who are left ACTIVE.
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { decideAccess } from '../services/balance.engine';

const APPLY = process.argv.includes('--apply');

// Obvious non-real accounts to leave alone.
const TEST_PATTERNS = [
  /@client\.user$/i,
  /@user\.com$/i,
  /@tset\.user$/i,
  /^curacao@curacao\.com$/i,
  /^test/i,
];
function isTestAccount(email: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(email));
}

function iso(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : '—';
}

async function main(): Promise<void> {
  const now = new Date();
  logger.info({ mode: APPLY ? 'APPLY' : 'DRY-RUN' }, 'remediate.start');

  const clients = await prisma.client.findMany({
    where: { status: 'ACTIVE', isUnlimited: false },
    select: {
      id: true,
      email: true,
      tenantId: true,
      lastPaymentAt: true,
      accessExpiresAt: true,
    },
  });

  const toBlock: Array<{ id: string; tenantId: string; email: string; lastPay: string }> = [];
  const skippedTest: string[] = [];
  let kept = 0;

  for (const c of clients) {
    const decision = decideAccess({
      isUnlimited: false,
      latestPaymentAt: c.lastPaymentAt,
      now,
    });
    if (decision.shouldRestore) {
      kept += 1;
      continue;
    }
    if (isTestAccount(c.email)) {
      skippedTest.push(c.email);
      continue;
    }
    toBlock.push({
      id: c.id,
      tenantId: c.tenantId,
      email: c.email,
      lastPay: iso(c.lastPaymentAt),
    });
  }

  // eslint-disable-next-line no-console
  console.log('\n=== SUMMARY ===');
  // eslint-disable-next-line no-console
  console.table({
    activeExamined: clients.length,
    keptActive: kept,
    skippedTestAccounts: skippedTest.length,
    wouldBlock: toBlock.length,
  });
  // eslint-disable-next-line no-console
  console.log('\n=== WOULD BLOCK ===');
  // eslint-disable-next-line no-console
  console.table(toBlock.map((b) => ({ email: b.email, lastPay: b.lastPay })));
  if (skippedTest.length) {
    // eslint-disable-next-line no-console
    console.log('\nskipped test accounts:', skippedTest.join(', '));
  }

  if (!APPLY) {
    logger.info(
      { wouldBlock: toBlock.length },
      'remediate.dryrun.done — no writes. Re-run with `-- --apply` to block.',
    );
    return;
  }

  let blocked = 0;
  let failed = 0;
  for (const b of toBlock) {
    try {
      await prisma.$transaction([
        prisma.client.update({
          where: { id: b.id },
          data: { status: 'BLOCKED', accessExpiresAt: null, lastSyncedAt: now },
        }),
        prisma.actionLog.create({
          data: {
            clientId: b.id,
            kind: 'DECISION_BLOCK',
            message:
              'Remediation: no qualifying recent payment — local status set to BLOCKED. ' +
              'ABC Track expiration lapsed on its own; no ABC Track call made.',
            details: { lastPaymentAt: b.lastPay },
          },
        }),
        prisma.syncRun.create({
          data: {
            tenantId: b.tenantId,
            clientId: b.id,
            trigger: 'CRON',
            outcome: 'BLOCKED',
            finishedAt: now,
            notes: 'Remediation sweep — local-only status correction.',
          },
        }),
      ]);
      blocked += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ clientId: b.id, err: (err as Error).message }, 'remediate.block.failed');
    }
  }
  logger.info({ blocked, failed }, 'remediate.apply.done');
}

main().catch(async (e) => {
  logger.error({ err: (e as Error).message }, 'remediate.fatal');
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
