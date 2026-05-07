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

export interface BalanceDecision {
  // Outstanding total across ALL invoices, in client currency.
  outstanding: Decimal;
  // True only when outstanding === 0 AND every invoice was parseable.
  // If any invoice had ambiguous data, this is FALSE.
  shouldRestore: boolean;
  // Most recent dueDate among PAID invoices. Null if no fully-paid invoice
  // could be identified — which means we cannot extend access either.
  paidThroughDate: Date | null;
  // Why we decided what we decided. Stored verbatim in ActionLog.
  reason: string;
  // Per-invoice rollup for the audit trail.
  perInvoice: Array<{
    id: string;
    balance: string;
    status: string;
    parseable: boolean;
  }>;
}

export interface DecisionContext {
  triggerEventId?: string;
  trigger: 'WEBHOOK' | 'MANUAL' | 'CRON' | 'RETRY';
  reason?: string;
}
