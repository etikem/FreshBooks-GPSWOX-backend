import { describe, it, expect } from 'vitest';
import { nextMonthTenthAtEightUtc } from '../src/utils/expiration';

/**
 * Business rule: a successful payment in month M grants access through
 * the 10th of month M+1 at 08:00:00 UTC. UTC throughout — DST cannot move
 * the deadline.
 */
describe('nextMonthTenthAtEightUtc', () => {
  it('payment early in month → 10th of next month', () => {
    const got = nextMonthTenthAtEightUtc(new Date('2026-04-02T00:00:00Z'));
    expect(got.toISOString()).toBe('2026-05-10T08:00:00.000Z');
  });

  it('payment mid-month → 10th of next month', () => {
    const got = nextMonthTenthAtEightUtc(new Date('2026-04-12T15:30:00Z'));
    expect(got.toISOString()).toBe('2026-05-10T08:00:00.000Z');
  });

  it('payment late-in-month → 10th of next month (only 11 days of access)', () => {
    const got = nextMonthTenthAtEightUtc(new Date('2026-05-30T20:00:00Z'));
    expect(got.toISOString()).toBe('2026-06-10T08:00:00.000Z');
  });

  it('payment on the last second of the month rolls to next month', () => {
    const got = nextMonthTenthAtEightUtc(new Date('2026-01-31T23:59:59Z'));
    expect(got.toISOString()).toBe('2026-02-10T08:00:00.000Z');
  });

  it('payment in December → 10th of January next year', () => {
    const got = nextMonthTenthAtEightUtc(new Date('2026-12-15T10:00:00Z'));
    expect(got.toISOString()).toBe('2027-01-10T08:00:00.000Z');
  });

  it('payment in February of a leap year → March 10', () => {
    const got = nextMonthTenthAtEightUtc(new Date('2028-02-29T12:00:00Z'));
    expect(got.toISOString()).toBe('2028-03-10T08:00:00.000Z');
  });

  it('payment exactly on a 10th still maps to the following month', () => {
    // Per spec: month derives from payment's UTC month, regardless of day.
    // A payment on the 10th still gives access through the NEXT month's 10th.
    const got = nextMonthTenthAtEightUtc(new Date('2026-06-10T08:00:00Z'));
    expect(got.toISOString()).toBe('2026-07-10T08:00:00.000Z');
  });

  it('returns 08:00 UTC regardless of payment time-of-day', () => {
    const got = nextMonthTenthAtEightUtc(new Date(Date.UTC(2026, 5, 9, 23, 0, 0)));
    expect(got.getUTCHours()).toBe(8);
    expect(got.getUTCMinutes()).toBe(0);
    expect(got.getUTCSeconds()).toBe(0);
    expect(got.getUTCDate()).toBe(10);
    expect(got.getUTCMonth()).toBe(6); // July
  });
});
