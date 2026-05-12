import { nextMonthTenthAtEightUtc } from '../utils/expiration';
import type { AccessDecision } from '../types';

/**
 * Access engine — payment-driven.
 * ────────────────────────────────
 * The single source of truth for the access decision.
 *
 * Rules (strict, in priority order):
 *
 *   1. Unlimited bypass. If `client.isUnlimited === true` the client is
 *      ACTIVE with NO ABC Track expiration (we send
 *      `enable_expiration_date=0`). Billing automation is skipped
 *      entirely — outstanding invoices, missing payments, expired
 *      contract dates are all ignored. Unlimited accounts are managed
 *      outside billing.
 *
 *   2. No payment → BLOCK. If we have no record of a successful
 *      payment, access is denied. Brand-new clients sit in this state
 *      until the first payment webhook arrives.
 *
 *   3. Expiration = next month's 10th at 08:00 UTC. Computed from the
 *      most recent successful payment's UTC date. A payment in any month
 *      M grants access through the 10th of month M+1, regardless of when
 *      in M it landed. See utils/expiration.ts.
 *
 *   4. Contract end clamp. Never push an expiration past
 *      `contractEndDate`. If the computed date exceeds the contract end,
 *      use the contract end.
 *
 *   5. If the computed expiration is already in the past, BLOCK. (This
 *      is how the monthly grace period rolls over: a payment from
 *      April → access until May 10 08:00 UTC; if no new payment arrives
 *      before then, the cron sweep finds this client on May 10 and
 *      blocks.)
 *
 * Invoice balances, paid-through dates, credit memos: irrelevant.
 */

export interface AccessDecisionInput {
  isUnlimited: boolean;
  contractEndDate: Date;
  // Latest successful payment we have on record (max PaymentLog.paidAt).
  // Null when the client has no payment history.
  latestPaymentAt: Date | null;
  now?: Date;
}

export function decideAccess(input: AccessDecisionInput): AccessDecision {
  const now = input.now ?? new Date();

  if (input.isUnlimited) {
    return {
      shouldRestore: true,
      isUnlimited: true,
      latestPaymentAt: null,
      effectiveAccessExpiresAt: null,
      reason: 'Unlimited account — billing automation bypassed.',
    };
  }

  if (!input.latestPaymentAt) {
    return {
      shouldRestore: false,
      isUnlimited: false,
      latestPaymentAt: null,
      effectiveAccessExpiresAt: null,
      reason: 'No payment on record — BLOCK.',
    };
  }

  const snapped = nextMonthTenthAtEightUtc(input.latestPaymentAt);
  const effective =
    snapped.getTime() > input.contractEndDate.getTime()
      ? input.contractEndDate
      : snapped;

  if (effective.getTime() <= now.getTime()) {
    return {
      shouldRestore: false,
      isUnlimited: false,
      latestPaymentAt: input.latestPaymentAt,
      effectiveAccessExpiresAt: null,
      reason: `Latest payment ${input.latestPaymentAt
        .toISOString()
        .slice(0, 10)} → expiration ${effective
        .toISOString()
        .slice(0, 10)} has elapsed. BLOCK.`,
    };
  }

  return {
    shouldRestore: true,
    isUnlimited: false,
    latestPaymentAt: input.latestPaymentAt,
    effectiveAccessExpiresAt: effective,
    reason: `Latest payment ${input.latestPaymentAt
      .toISOString()
      .slice(0, 10)} → access through ${effective
      .toISOString()
      .slice(0, 10)}.`,
  };
}
