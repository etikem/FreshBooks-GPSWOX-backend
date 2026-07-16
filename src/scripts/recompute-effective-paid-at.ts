/**
 * Recompute `effectivePaidAt` for every existing PaymentLog row and re-apply
 * access decisions under the back-dating-safe rule.
 *
 *   effectivePaidAt = MAX(payment.date, settled-invoice.date)
 *
 * Motivation: FreshBooks payments are sometimes back-dated (payment.date set
 * to when funds arrived) while settling an invoice for a LATER period. The old
 * engine keyed off payment.date alone and granted a too-short access window
 * (Jeremy Coenraad / invoice 011937: paid 2026-06-30, invoice 2026-07-01,
 * wrongly expired 2026-07-10 instead of 2026-08-10).
 *
 * DRY-RUN BY DEFAULT. Prints every client whose lastPaymentAt / access
 * decision would change, and never writes to ABC Track. Pass `--apply` to
 * persist effectivePaidAt, refresh lastPaymentAt, and re-run evaluateAndApply
 * (which pushes ABC Track enable for anyone newly qualifying).
 *
 *   npm run recompute:effective-paid-at            # dry-run
 *   npm run recompute:effective-paid-at -- --apply # live
 *
 * Performance: invoice dates are bulk-loaded from the local invoice_cache in
 * one query (no per-row FreshBooks calls). Any invoice not in the cache is
 * fetched from FreshBooks once and memoised. The rule can only ever EXTEND
 * access (MAX(...)), never revoke it, so re-applying is safe and idempotent.
 */
import 'dotenv/config';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { loadTokens as loadFreshbooksTokens } from '../services/freshbooks-token.service';
import { freshbooksService } from '../services/freshbooks.service';
import { effectivePaidDate, evaluateAndApply } from '../services/webhook.service';
import { decideAccess } from '../services/balance.engine';

const APPLY = process.argv.includes('--apply');

function iso(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : '—';
}

async function main(): Promise<void> {
  await loadFreshbooksTokens();
  logger.info({ mode: APPLY ? 'APPLY' : 'DRY-RUN' }, 'recompute.effective-paid-at.start');

  // ── 0. Bulk-load invoice dates from the local cache into a map.
  const cachedInvoices = await prisma.invoiceCache.findMany({
    where: { issuedDate: { not: null } },
    select: { freshbooksInvoiceId: true, issuedDate: true },
  });
  const invoiceDate = new Map<string, Date>();
  for (const inv of cachedInvoices) {
    if (inv.issuedDate) invoiceDate.set(inv.freshbooksInvoiceId, inv.issuedDate);
  }
  logger.info({ cached: invoiceDate.size }, 'recompute.invoice-cache.loaded');

  // Memoised FreshBooks fallback for invoices missing from the cache.
  const fetched = new Map<string, Date | null>();
  async function resolveInvoiceDate(invoiceId: string): Promise<Date | null> {
    const cached = invoiceDate.get(invoiceId);
    if (cached) return cached;
    if (fetched.has(invoiceId)) return fetched.get(invoiceId)!;
    let d: Date | null = null;
    try {
      d = await freshbooksService.getInvoiceIssuedDate(invoiceId);
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, invoiceId },
        'recompute.invoice-date.fetch-failed',
      );
    }
    fetched.set(invoiceId, d);
    if (d) invoiceDate.set(invoiceId, d);
    return d;
  }

  // ── 1. Recompute effectivePaidAt for every payment row that has a paidAt.
  //     Track the per-client MAX(effectivePaidAt) in the same pass.
  const payments = await prisma.paymentLog.findMany({
    where: { paidAt: { not: null } },
    select: {
      id: true,
      clientId: true,
      paidAt: true,
      invoiceId: true,
      effectivePaidAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  logger.info({ n: payments.length }, 'recompute.payments.loaded');

  const affectedClientIds = new Set<string>();
  const newMaxByClient = new Map<string, Date>();
  let rowsChanged = 0;
  let rowScanned = 0;

  for (const p of payments) {
    rowScanned += 1;
    const invDate = p.invoiceId ? await resolveInvoiceDate(p.invoiceId) : null;
    const eff = effectivePaidDate(p.paidAt, invDate);

    // Track per-client max of the new effective date.
    if (eff) {
      const prev = newMaxByClient.get(p.clientId);
      if (!prev || eff.getTime() > prev.getTime()) {
        newMaxByClient.set(p.clientId, eff);
      }
    }

    const current = p.effectivePaidAt?.getTime() ?? null;
    const next = eff?.getTime() ?? null;
    if (current !== next) {
      rowsChanged += 1;
      affectedClientIds.add(p.clientId);
      if (APPLY) {
        await prisma.paymentLog.update({
          where: { id: p.id },
          data: { effectivePaidAt: eff },
        });
      }
    }
    if (rowScanned % 1000 === 0) {
      logger.info({ rowScanned, rowsChanged }, 'recompute.payments.progress');
    }
  }
  logger.info(
    { rowScanned, rowsChanged, affectedClients: affectedClientIds.size },
    'recompute.payments.done',
  );

  // ── 2. Build the work-list from DB TRUTH, not from what changed this run.
  //   A client needs work if its stored lastPaymentAt disagrees with the
  //   recomputed MAX(effectivePaidAt). This makes the script correctly
  //   RESUMABLE: on a re-run after the effectivePaidAt rows are already
  //   persisted, we still pick up every client whose lastPaymentAt / access
  //   hasn't yet been refreshed. (affectedClientIds — this-run row changes —
  //   is kept only for the progress log above.)
  const candidateIds = [...newMaxByClient.keys()];
  const candidateClients = await prisma.client.findMany({
    where: { id: { in: candidateIds } },
    select: { id: true, lastPaymentAt: true },
  });
  const clientIds: string[] = [];
  for (const c of candidateClients) {
    const target = newMaxByClient.get(c.id) ?? null;
    const cur = c.lastPaymentAt?.getTime() ?? null;
    const tgt = target?.getTime() ?? null;
    if (cur !== tgt) clientIds.push(c.id);
  }
  const now = new Date();
  let wouldRestore = 0;
  const rows: Array<{
    email: string;
    oldLastPay: string;
    newLastPay: string;
    oldStatus: string;
    newExpires: string;
    change: string;
  }> = [];

  const affectedClients = await prisma.client.findMany({
    where: { id: { in: clientIds } },
  });
  const clientById = new Map(affectedClients.map((c) => [c.id, c]));

  for (const clientId of clientIds) {
    const client = clientById.get(clientId);
    if (!client) continue;

    const newLastPay = newMaxByClient.get(clientId) ?? null;
    const newDecision = decideAccess({
      isUnlimited: client.isUnlimited,
      latestPaymentAt: newLastPay,
      now,
    });
    if (newDecision.shouldRestore) wouldRestore += 1;

    rows.push({
      email: client.email,
      oldLastPay: iso(client.lastPaymentAt),
      newLastPay: iso(newLastPay),
      oldStatus: client.status,
      newExpires: iso(newDecision.effectiveAccessExpiresAt),
      change: newDecision.shouldRestore ? 'RESTORE' : 'BLOCK',
    });
  }

  // Sort so the most interesting rows (date actually moved) surface first.
  rows.sort((a, b) => (a.newLastPay < b.newLastPay ? 1 : -1));
  // eslint-disable-next-line no-console
  console.table(rows);
  logger.info(
    { affected: clientIds.length, wouldRestore },
    APPLY ? 'recompute.reapply.summary' : 'recompute.dryrun.summary',
  );

  if (!APPLY) {
    logger.info(
      'DRY-RUN complete — no writes made. Re-run with `-- --apply` to persist and re-sync ABC Track.',
    );
    return;
  }

  // ── 3a. APPLY (fast, DB-only): refresh lastPaymentAt for ALL affected
  //     clients up front in one pass. This is what the access engine reads,
  //     so it must be correct even if the slow ABC Track loop below is
  //     interrupted. Decoupled deliberately.
  for (const clientId of clientIds) {
    await prisma.client.update({
      where: { id: clientId },
      data: { lastPaymentAt: newMaxByClient.get(clientId) ?? null },
    });
  }
  logger.info({ n: clientIds.length }, 'recompute.lastpayment.refreshed');

  // ── 3b. APPLY (slow, network): re-run the decision pipeline, which pushes
  //     ABC Track enable where newly qualifying. RESUMABLE: skip clients that
  //     already match the target state so re-runs after a timeout don't
  //     re-fire completed clients. Each call is idempotent regardless.
  const now2 = new Date();
  let reapplied = 0;
  let skipped = 0;
  let failed = 0;
  let idx = 0;
  for (const clientId of clientIds) {
    idx += 1;
    try {
      const client = clientById.get(clientId);
      if (!client) continue;
      const target = decideAccess({
        isUnlimited: client.isUnlimited,
        latestPaymentAt: newMaxByClient.get(clientId) ?? null,
        now: now2,
      });
      // Re-read current DB state (may have been updated by an earlier,
      // interrupted run of this same script).
      const fresh = await prisma.client.findUnique({
        where: { id: clientId },
        select: { status: true, accessExpiresAt: true },
      });
      const targetStatus = target.shouldRestore ? 'ACTIVE' : 'BLOCKED';
      const targetExp = target.effectiveAccessExpiresAt?.getTime() ?? null;
      const curExp = fresh?.accessExpiresAt?.getTime() ?? null;
      // Already in the target state → skip (nothing to push to ABC Track).
      if (fresh?.status === targetStatus && curExp === targetExp) {
        skipped += 1;
        continue;
      }
      await evaluateAndApply({ clientId, trigger: 'MANUAL' });
      reapplied += 1;
      if (idx % 10 === 0) {
        logger.info({ idx, total: clientIds.length, reapplied, skipped }, 'recompute.reapply.progress');
      }
    } catch (err) {
      failed += 1;
      logger.warn(
        { clientId, err: (err as Error).message },
        'recompute.reapply.client.failed',
      );
    }
  }
  logger.info({ reapplied, skipped, failed }, 'recompute.reapply.done');
}

main()
  .catch((err) => {
    logger.error({ err: (err as Error).message }, 'recompute.effective-paid-at.fatal');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
