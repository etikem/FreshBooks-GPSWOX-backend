import { describe, it, expect } from 'vitest';
import { effectivePaidDate } from '../src/services/webhook.service';
import { decideAccess } from '../src/services/balance.engine';
import { nextMonthTenthAtEightUtc } from '../src/utils/expiration';

/**
 * Back-dating-safe access window.
 *
 * effectivePaidDate = MAX(payment date, settled-invoice date), then the
 * existing engine turns that into "10th of the following month".
 */

const d = (s: string) => new Date(s);

describe('effectivePaidDate — the pure MAX rule', () => {
  it('returns null when there is no paid date', () => {
    expect(effectivePaidDate(null, d('2026-07-01'))).toBeNull();
    expect(effectivePaidDate(null, null)).toBeNull();
  });

  it('degrades to the payment date when no invoice date (today\'s behaviour)', () => {
    expect(effectivePaidDate(d('2026-07-15'), null)?.toISOString()).toBe(
      d('2026-07-15').toISOString(),
    );
  });

  it('uses the invoice date when it is LATER than the payment date (back-dating case)', () => {
    // Jeremy Coenraad / invoice 011937: paid 2026-06-30, invoice 2026-07-01.
    const eff = effectivePaidDate(d('2026-06-30'), d('2026-07-01'));
    expect(eff?.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('keeps the payment date when the invoice date is earlier', () => {
    // A payment made after its invoice — normal case, invoice must not pull back.
    const eff = effectivePaidDate(d('2026-07-15'), d('2026-07-01'));
    expect(eff?.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('keeps the payment date when the two are equal', () => {
    const eff = effectivePaidDate(d('2026-07-01'), d('2026-07-01'));
    expect(eff?.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('never REDUCES the date — invoice earlier by a month still yields payment date', () => {
    const eff = effectivePaidDate(d('2026-07-05'), d('2026-06-01'));
    expect(eff?.toISOString().slice(0, 10)).toBe('2026-07-05');
  });
});

describe('end-to-end: Jeremy Coenraad case through the engine', () => {
  const NOW = d('2026-07-11T12:00:00Z'); // after Jul 10, before Aug 10

  it('OLD behaviour (payment date only) would BLOCK on Jul 11', () => {
    const decision = decideAccess({
      isUnlimited: false,
      latestPaymentAt: d('2026-06-30'), // raw payment date
      now: NOW,
    });
    // Jun 30 -> access through Jul 10 -> already elapsed on Jul 11.
    expect(decision.shouldRestore).toBe(false);
  });

  it('NEW behaviour (effective date = invoice month) RESTORES through Aug 10', () => {
    const effective = effectivePaidDate(d('2026-06-30'), d('2026-07-01'));
    const decision = decideAccess({
      isUnlimited: false,
      latestPaymentAt: effective, // = 2026-07-01
      now: NOW,
    });
    expect(decision.shouldRestore).toBe(true);
    expect(decision.effectiveAccessExpiresAt?.toISOString()).toBe(
      d('2026-08-10T08:00:00Z').toISOString(),
    );
  });
});

describe('month/year boundary sanity via nextMonthTenthAtEightUtc', () => {
  it('effective Jul 1 -> Aug 10 08:00 UTC', () => {
    const eff = effectivePaidDate(d('2026-06-30'), d('2026-07-01'))!;
    expect(nextMonthTenthAtEightUtc(eff).toISOString()).toBe(
      '2026-08-10T08:00:00.000Z',
    );
  });

  it('year rollover: effective Dec 31 -> Jan 10 next year', () => {
    // paid Nov 30 (back-dated), invoice Dec 31.
    const eff = effectivePaidDate(d('2026-11-30'), d('2026-12-31'))!;
    expect(nextMonthTenthAtEightUtc(eff).toISOString()).toBe(
      '2027-01-10T08:00:00.000Z',
    );
  });
});
