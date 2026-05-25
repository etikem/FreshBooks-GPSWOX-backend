import { describe, it, expect } from 'vitest';
import { decideAccess } from '../src/services/balance.engine';

/**
 * Payment-driven access engine. See backend/src/services/balance.engine.ts
 * for the rule precedence.
 */

const NOW = new Date('2026-05-12T12:00:00Z');

describe('decideAccess — unlimited bypass', () => {
  it('unlimited account is ACTIVE with no expiration even with no payment', () => {
    const d = decideAccess({
      isUnlimited: true,
      latestPaymentAt: null,
      now: NOW,
    });
    expect(d.shouldRestore).toBe(true);
    expect(d.isUnlimited).toBe(true);
    expect(d.effectiveAccessExpiresAt).toBeNull();
    expect(d.reason).toMatch(/Unlimited/i);
  });

  it('unlimited bypass wins over an expired payment', () => {
    const d = decideAccess({
      isUnlimited: true,
      // Payment from 6 months ago — would normally be BLOCKED.
      latestPaymentAt: new Date('2025-11-01T00:00:00Z'),
      now: NOW,
    });
    expect(d.shouldRestore).toBe(true);
    expect(d.isUnlimited).toBe(true);
    expect(d.effectiveAccessExpiresAt).toBeNull();
  });
});

describe('decideAccess — no payment on record', () => {
  it('BLOCKS a brand-new client with no payment history', () => {
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: null,
      now: NOW,
    });
    expect(d.shouldRestore).toBe(false);
    expect(d.isUnlimited).toBe(false);
    expect(d.effectiveAccessExpiresAt).toBeNull();
    expect(d.reason).toMatch(/No payment/i);
  });
});

describe('decideAccess — payment → next-month 10th', () => {
  it('payment on Apr 2 → access through May 10 08:00 UTC', () => {
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: new Date('2026-04-02T00:00:00Z'),
      now: new Date('2026-04-05T00:00:00Z'),
    });
    expect(d.shouldRestore).toBe(true);
    expect(d.effectiveAccessExpiresAt?.toISOString()).toBe('2026-05-10T08:00:00.000Z');
  });

  it('payment on Apr 12 → access through May 10 08:00 UTC (matches business example)', () => {
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: new Date('2026-04-12T00:00:00Z'),
      now: new Date('2026-04-15T00:00:00Z'),
    });
    expect(d.shouldRestore).toBe(true);
    expect(d.effectiveAccessExpiresAt?.toISOString()).toBe('2026-05-10T08:00:00.000Z');
  });

  it('payment on May 30 → access through Jun 10 08:00 UTC (only 11 days of access)', () => {
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: new Date('2026-05-30T00:00:00Z'),
      now: new Date('2026-05-31T00:00:00Z'),
    });
    expect(d.shouldRestore).toBe(true);
    expect(d.effectiveAccessExpiresAt?.toISOString()).toBe('2026-06-10T08:00:00.000Z');
  });
});

describe('decideAccess — grace period boundary', () => {
  it('active until the 10th at 08:00 UTC', () => {
    // Payment in April → expiration May 10 08:00. At May 10 07:59 still ACTIVE.
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: new Date('2026-04-12T00:00:00Z'),
      now: new Date('2026-05-10T07:59:00Z'),
    });
    expect(d.shouldRestore).toBe(true);
  });

  it('blocked once expiration moment passes', () => {
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: new Date('2026-04-12T00:00:00Z'),
      now: new Date('2026-05-10T08:00:00Z'),
    });
    expect(d.shouldRestore).toBe(false);
    expect(d.effectiveAccessExpiresAt).toBeNull();
    expect(d.reason).toMatch(/elapsed|BLOCK/i);
  });

  it('blocked after the 10th when no fresh payment landed', () => {
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: new Date('2026-04-12T00:00:00Z'),
      now: new Date('2026-05-11T00:00:00Z'),
    });
    expect(d.shouldRestore).toBe(false);
  });
});

describe('decideAccess — caller passes the latest payment', () => {
  it('uses whatever latestPaymentAt the caller provides (reversal scenario)', () => {
    // Simulates payment.delete: caller has already dropped the latest
    // payment from PaymentLog and re-read MAX(paidAt). Engine works off
    // whatever it's given.
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: new Date('2026-03-15T00:00:00Z'), // post-reversal
      now: new Date('2026-05-12T00:00:00Z'),
    });
    expect(d.shouldRestore).toBe(false);
    expect(d.reason).toMatch(/elapsed|BLOCK/i);
  });

  it('uses the latest payment when given (multiple payments → caller picks)', () => {
    const d = decideAccess({
      isUnlimited: false,
      latestPaymentAt: new Date('2026-05-07T00:00:00Z'),
      now: new Date('2026-05-08T00:00:00Z'),
    });
    expect(d.shouldRestore).toBe(true);
    expect(d.effectiveAccessExpiresAt?.toISOString()).toBe('2026-06-10T08:00:00.000Z');
  });
});
