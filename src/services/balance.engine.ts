import Decimal from 'decimal.js';
import { ZERO, isZero, isPositive, sum, format, toMoney } from '../utils/decimal';
import type { FreshbooksInvoice, BalanceDecision } from '../types';

/**
 * BalanceEngine
 * ─────────────
 * The single source of truth for the access decision.
 *
 * Rules (strict, in priority order):
 *
 *   1. If the invoice list is empty → BLOCK. We never restore based on
 *      "no data" — that is itself ambiguity.
 *
 *   2. Use `invoice.balance` only. NEVER `total - paid` reconstruction here.
 *      FreshBooks computes balance authoritatively (including credit notes,
 *      taxes, partial allocations, refunds). Reconstructing it ourselves
 *      will silently disagree.
 *
 *   3. If ANY invoice has an unparseable balance → BLOCK. Treat null/NaN
 *      as outstanding-and-then-some.
 *
 *   4. If ANY invoice balance is negative (credit memo, overpayment), it
 *      does NOT offset a positive balance elsewhere. Negative balances are
 *      treated as zero for the purpose of "is the customer paid up?". This
 *      avoids a credit memo on one invoice masking arrears on another.
 *
 *   5. Outstanding total is sum of MAX(balance, 0) across all invoices.
 *
 *   6. shouldRestore = (outstanding == 0) AND (every invoice was parseable)
 *      AND (we found at least one fully-paid invoice from which to derive
 *      paidThroughDate). The contract-aware date check happens in the
 *      caller — this engine only computes the strict financial truth.
 *
 *   7. paidThroughDate = max dueDate among invoices with balance == 0.
 *      If we cannot compute it, it's null and the caller MUST block.
 */
export interface BalanceEngineInput {
  invoices: FreshbooksInvoice[];
}

export function calculateOutstandingBalance(input: BalanceEngineInput): BalanceDecision {
  const { invoices } = input;
  const perInvoice: BalanceDecision['perInvoice'] = [];

  if (invoices.length === 0) {
    return {
      outstanding: ZERO,
      shouldRestore: false,
      paidThroughDate: null,
      reason:
        'No invoices returned from FreshBooks — cannot prove the client is paid up. BLOCK.',
      perInvoice,
    };
  }

  let total = ZERO;
  let anyAmbiguous = false;
  let paidThroughDate: Date | null = null;

  for (const inv of invoices) {
    const balance = toMoney(inv.balance);

    if (balance === null) {
      anyAmbiguous = true;
      perInvoice.push({
        id: inv.id,
        balance: 'unparseable',
        status: inv.status,
        parseable: false,
      });
      continue;
    }

    // Rule 4: clamp negative balances to zero.
    const contribution = isPositive(balance) ? balance : ZERO;
    total = total.plus(contribution);

    perInvoice.push({
      id: inv.id,
      balance: format(balance),
      status: inv.status,
      parseable: true,
    });

    // Rule 7: track the latest dueDate among fully-paid invoices.
    if (isZero(balance) && inv.dueDate instanceof Date) {
      if (!paidThroughDate || inv.dueDate.getTime() > paidThroughDate.getTime()) {
        paidThroughDate = inv.dueDate;
      }
    }
  }

  if (anyAmbiguous) {
    return {
      outstanding: total,
      shouldRestore: false,
      paidThroughDate,
      reason:
        'At least one invoice had an unparseable balance — refusing to restore on partial truth. BLOCK.',
      perInvoice,
    };
  }

  if (isPositive(total)) {
    return {
      outstanding: total,
      shouldRestore: false,
      paidThroughDate,
      reason: `Outstanding balance is ${format(total)} (> 0). BLOCK.`,
      perInvoice,
    };
  }

  if (!paidThroughDate) {
    return {
      outstanding: total,
      shouldRestore: false,
      paidThroughDate: null,
      reason:
        'Outstanding is zero but no paid invoice with a due date was found — cannot derive paid-through date. BLOCK.',
      perInvoice,
    };
  }

  return {
    outstanding: total,
    shouldRestore: true,
    paidThroughDate,
    reason: `All invoices clear. Paid through ${paidThroughDate.toISOString().slice(0, 10)}. RESTORE allowed.`,
    perInvoice,
  };
}

/**
 * Combine the strict balance check with the contract-aware paid-through
 * window. This is the function callers should use — it folds in step 5
 * of the spec ("paidThroughDate >= today").
 */
export interface AccessDecisionInput extends BalanceEngineInput {
  contractEndDate: Date;
  now?: Date;
}

export interface AccessDecision extends BalanceDecision {
  // The effective expiration we will push to GPSWOX (capped at contractEndDate).
  effectiveAccessExpiresAt: Date | null;
}

export function decideAccess(input: AccessDecisionInput): AccessDecision {
  const balance = calculateOutstandingBalance(input);
  const now = input.now ?? new Date();

  if (!balance.shouldRestore) {
    return { ...balance, effectiveAccessExpiresAt: null };
  }

  const paidThrough = balance.paidThroughDate!;
  if (paidThrough.getTime() < startOfDay(now).getTime()) {
    return {
      ...balance,
      shouldRestore: false,
      reason: `Outstanding is zero but paid-through date ${paidThrough.toISOString().slice(0, 10)} is in the past. BLOCK.`,
      effectiveAccessExpiresAt: null,
    };
  }

  // Cap access at contract end — never extend past it.
  const cap = input.contractEndDate;
  const effective =
    paidThrough.getTime() > cap.getTime() ? cap : paidThrough;

  return {
    ...balance,
    effectiveAccessExpiresAt: effective,
  };
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setUTCHours(0, 0, 0, 0);
  return c;
}

// Re-export for tests.
export { Decimal };
