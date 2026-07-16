/**
 * READ-ONLY audit. Runs every ACTIVE, non-unlimited client through the real
 * decideAccess engine and classifies them. Writes NOTHING.
 *
 * Purpose: find clients who are ACTIVE but shouldn't be under the
 * "access requires a qualifying recent payment" rule — e.g. auto-created
 * clients that never paid, or clients whose access window already lapsed but
 * were never blocked (cron gap).
 *
 *   npm run audit:active-access
 *
 * Categories:
 *   KEEP            — engine says RESTORE (has a current-enough payment).
 *   BLOCK_NO_PAYMENT— no payment on record at all; access should be revoked.
 *   BLOCK_LAPSED    — has payments but newest is too old; window elapsed.
 *   REVIEW_STALE_EXP— engine says RESTORE, but stored accessExpiresAt is
 *                     already in the past → data drift; would NOT be blocked
 *                     by the remediation, flagged for eyeballing.
 *   DANGER_PAID_RECENT_BUT_BLOCKED — engine says BLOCK, yet the client has a
 *                     payment within the last ~40 days. Possible mis-recorded
 *                     payment date. DO NOT blindly block these.
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { decideAccess } from '../services/balance.engine';

const RECENT_DAYS = 40;

function iso(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : '—';
}

async function main(): Promise<void> {
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - RECENT_DAYS * 86400000);

  const clients = await prisma.client.findMany({
    where: { status: 'ACTIVE', isUnlimited: false },
    select: {
      id: true,
      email: true,
      lastPaymentAt: true,
      accessExpiresAt: true,
      gpswoxUserId: true,
    },
  });

  type Row = Record<string, string>;
  const KEEP: Row[] = [];
  const BLOCK_NO_PAYMENT: Row[] = [];
  const BLOCK_LAPSED: Row[] = [];
  const REVIEW_STALE_EXP: Row[] = [];
  const DANGER_PAID_RECENT_BUT_BLOCKED: Row[] = [];

  for (const c of clients) {
    const decision = decideAccess({
      isUnlimited: false,
      latestPaymentAt: c.lastPaymentAt,
      now,
    });

    // Does the client have ANY payment newer than the cutoff? (checked against
    // the raw PaymentLog, not just lastPaymentAt, to catch mis-mirrored rows.)
    const recentPay = await prisma.paymentLog.findFirst({
      where: { clientId: c.id, effectivePaidAt: { gte: recentCutoff } },
      select: { effectivePaidAt: true },
      orderBy: { effectivePaidAt: 'desc' },
    });

    const row = {
      email: c.email,
      lastPay: iso(c.lastPaymentAt),
      expires: iso(c.accessExpiresAt),
      mapped: c.gpswoxUserId ? 'yes' : 'NO',
    };

    if (decision.shouldRestore) {
      // Engine grants access. Is the stored expiry already past? (drift)
      if (c.accessExpiresAt && c.accessExpiresAt.getTime() < now.getTime()) {
        REVIEW_STALE_EXP.push(row);
      } else {
        KEEP.push(row);
      }
    } else {
      // Engine says BLOCK. But guard against blocking someone who paid recently.
      if (recentPay) {
        DANGER_PAID_RECENT_BUT_BLOCKED.push({
          ...row,
          recentPay: iso(recentPay.effectivePaidAt),
        });
      } else if (!c.lastPaymentAt) {
        BLOCK_NO_PAYMENT.push(row);
      } else {
        BLOCK_LAPSED.push(row);
      }
    }
  }

  const cat: Array<[string, Row[]]> = [
    ['KEEP', KEEP],
    ['BLOCK_NO_PAYMENT', BLOCK_NO_PAYMENT],
    ['BLOCK_LAPSED', BLOCK_LAPSED],
    ['REVIEW_STALE_EXP', REVIEW_STALE_EXP],
    ['DANGER_PAID_RECENT_BUT_BLOCKED', DANGER_PAID_RECENT_BUT_BLOCKED],
  ];

  const summary = Object.fromEntries(cat.map(([k, v]) => [k, v.length]));
  // eslint-disable-next-line no-console
  console.log('\n=== SUMMARY (ACTIVE, non-unlimited:', clients.length, ') ===');
  // eslint-disable-next-line no-console
  console.table(summary);

  for (const [name, rows] of cat) {
    if (rows.length === 0) continue;
    // eslint-disable-next-line no-console
    console.log(`\n=== ${name} (${rows.length}) ===`);
    // eslint-disable-next-line no-console
    console.table(rows.slice(0, 60));
    if (rows.length > 60) console.log(`… and ${rows.length - 60} more`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error('AUDIT_ERROR:', (e as Error).message);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
