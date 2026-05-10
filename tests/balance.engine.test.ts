import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  calculateOutstandingBalance,
  decideAccess,
} from '../src/services/balance.engine';
import type { FreshbooksInvoice } from '../src/types';

function inv(partial: Omit<Partial<FreshbooksInvoice>, 'balance'> & { balance: string }): FreshbooksInvoice {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    invoiceNumber: partial.invoiceNumber ?? null,
    amount: partial.amount ?? new Decimal(partial.balance),
    paid: partial.paid ?? new Decimal(0),
    balance: new Decimal(partial.balance),
    currency: partial.currency ?? 'USD',
    status: partial.status ?? 'sent',
    issuedDate: 'issuedDate' in partial ? partial.issuedDate ?? null : new Date('2026-01-01'),
    dueDate: 'dueDate' in partial ? partial.dueDate ?? null : new Date('2026-01-15'),
  };
}

describe('BalanceEngine — strict outstanding rules', () => {
  it('BLOCKS when invoice list is empty (no proof of paid-up state)', () => {
    const d = calculateOutstandingBalance({ invoices: [] });
    expect(d.shouldRestore).toBe(false);
    expect(d.reason).toMatch(/No invoices/);
  });

  it('BLOCKS when one invoice paid but another still has balance', () => {
    const d = calculateOutstandingBalance({
      invoices: [
        inv({ balance: '0', status: 'paid' }),
        inv({ balance: '49.99', status: 'sent' }),
      ],
    });
    expect(d.shouldRestore).toBe(false);
    expect(d.outstanding.toFixed(2)).toBe('49.99');
  });

  it('BLOCKS on partial payment (balance > 0)', () => {
    const d = calculateOutstandingBalance({
      invoices: [
        inv({ balance: '10.00', paid: new Decimal('40.00'), status: 'partial' }),
      ],
    });
    expect(d.shouldRestore).toBe(false);
    expect(d.outstanding.toFixed(2)).toBe('10.00');
  });

  it('RESTORES when every invoice has zero balance', () => {
    const d = calculateOutstandingBalance({
      invoices: [
        inv({ balance: '0', status: 'paid', dueDate: new Date('2026-04-01') }),
        inv({ balance: '0', status: 'paid', dueDate: new Date('2026-05-01') }),
      ],
    });
    expect(d.shouldRestore).toBe(true);
    expect(d.outstanding.toFixed(2)).toBe('0.00');
    expect(d.paidThroughDate?.toISOString().slice(0, 10)).toBe('2026-05-01');
  });

  it('handles decimal noise without floating-point drift', () => {
    const d = calculateOutstandingBalance({
      invoices: [
        inv({ balance: '0.1' }),
        inv({ balance: '0.2' }),
      ],
    });
    // 0.1 + 0.2 in float would give 0.30000000000000004
    expect(d.outstanding.toFixed(2)).toBe('0.30');
    expect(d.shouldRestore).toBe(false);
  });

  it('treats unparseable balance as ambiguous → BLOCK', () => {
    const broken = inv({ balance: '0' });
    // simulate: the parser couldn't read the field
    // @ts-expect-error — intentionally corrupting for the test
    broken.balance = NaN;
    const d = calculateOutstandingBalance({ invoices: [broken] });
    expect(d.shouldRestore).toBe(false);
  });

  it('does NOT let a credit memo offset arrears on another invoice', () => {
    const d = calculateOutstandingBalance({
      invoices: [
        inv({ balance: '-50.00', status: 'paid' }), // credit memo
        inv({ balance: '50.00', status: 'sent' }),  // unpaid
      ],
    });
    expect(d.outstanding.toFixed(2)).toBe('50.00');
    expect(d.shouldRestore).toBe(false);
  });

  it('BLOCKS when zero balance but no paid invoice has a due date', () => {
    const d = calculateOutstandingBalance({
      invoices: [inv({ balance: '0', status: 'paid', dueDate: null })],
    });
    expect(d.shouldRestore).toBe(false);
    expect(d.reason).toMatch(/cannot derive paid-through/);
  });
});

describe('decideAccess — contract-aware', () => {
  const today = new Date('2026-04-30');

  it('RESTORES and snaps the expiration to the next 10th-of-month 08:00 UTC', () => {
    const d = decideAccess({
      invoices: [
        inv({ balance: '0', dueDate: new Date('2026-05-31'), status: 'paid' }),
      ],
      contractEndDate: new Date('2026-12-31'),
      now: today,
    });
    expect(d.shouldRestore).toBe(true);
    // paid-through 2026-05-31 ⇒ snap-forward to 2026-06-10 08:00 UTC.
    expect(d.effectiveAccessExpiresAt?.toISOString()).toBe(
      '2026-06-10T08:00:00.000Z',
    );
  });

  it('BLOCKS when paid-through is in the past, even if balance is zero', () => {
    const d = decideAccess({
      invoices: [
        inv({ balance: '0', dueDate: new Date('2026-03-01'), status: 'paid' }),
      ],
      contractEndDate: new Date('2026-12-31'),
      now: today,
    });
    expect(d.shouldRestore).toBe(false);
    expect(d.reason).toMatch(/in the past/);
  });

  it('caps access at contractEndDate', () => {
    const d = decideAccess({
      invoices: [
        inv({ balance: '0', dueDate: new Date('2027-06-30'), status: 'paid' }),
      ],
      contractEndDate: new Date('2026-12-31'),
      now: today,
    });
    expect(d.effectiveAccessExpiresAt?.toISOString().slice(0, 10)).toBe(
      '2026-12-31',
    );
  });
});
