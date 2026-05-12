import type { Decimal } from 'decimal.js';

export interface FreshbooksInvoice {
  id: string;
  invoiceNumber: string | null;
  // Total invoice amount.
  amount: Decimal;
  // Cumulative paid amount on this invoice.
  paid: Decimal;
  // Remaining balance for this invoice.
  balance: Decimal;
  currency: string;
  // FreshBooks display status: "paid", "partial", "sent", "overdue", "draft", etc.
  status: string;
  issuedDate: Date | null;
  dueDate: Date | null;
}

/**
 * Output of the payment-driven access engine. See balance.engine.ts.
 *
 * `effectiveAccessExpiresAt` is what we push to ABC Track:
 *   - A Date when access is granted with a normal expiration.
 *   - null when shouldRestore is true AND isUnlimited is true (the client
 *     has no expiration on ABC Track — `enable_expiration_date=0`).
 *   - null when shouldRestore is false (access is blocked).
 *
 * Callers MUST inspect `isUnlimited` to disambiguate the two null cases.
 */
export interface AccessDecision {
  shouldRestore: boolean;
  isUnlimited: boolean;
  // Most recent successful payment used to compute expiration. Null for
  // unlimited clients (we don't care) and for the no-payment-block case.
  latestPaymentAt: Date | null;
  effectiveAccessExpiresAt: Date | null;
  // Human-readable explanation, written to ActionLog.
  reason: string;
}

export interface DecisionContext {
  triggerEventId?: string;
  trigger: 'WEBHOOK' | 'MANUAL' | 'CRON' | 'RETRY';
  reason?: string;
}
