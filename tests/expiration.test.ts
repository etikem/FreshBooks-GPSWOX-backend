import { describe, it, expect } from 'vitest';
import { nextTenthAtEightUtc } from '../src/utils/expiration';

/**
 * Business rule: expiration is the next 10th-of-month at 08:00:00 UTC
 * STRICTLY AFTER `from`. UTC throughout — DST cannot move the deadline.
 */
describe('nextTenthAtEightUtc', () => {
  it('snaps mid-month to the 10th of the same month', () => {
    const got = nextTenthAtEightUtc(new Date('2026-06-09T12:00:00Z'));
    expect(got.toISOString()).toBe('2026-06-10T08:00:00.000Z');
  });

  it('snaps end-of-previous-month to the 10th of next month (Example A)', () => {
    // "March invoice → June 10th 08:00 AM" example: paid through end of May
    // ⇒ next 10th-of-month after that is June 10 08:00 UTC.
    const got = nextTenthAtEightUtc(new Date('2026-05-31T23:59:59Z'));
    expect(got.toISOString()).toBe('2026-06-10T08:00:00.000Z');
  });

  it('snaps end-of-month to the 10th of the next month (Example B)', () => {
    const got = nextTenthAtEightUtc(new Date('2026-06-30T12:00:00Z'));
    expect(got.toISOString()).toBe('2026-07-10T08:00:00.000Z');
  });

  it('treats exact 10th-08:00 as already-past, returns next month', () => {
    // Strict-after — equality must not return the same instant.
    const got = nextTenthAtEightUtc(new Date('2026-06-10T08:00:00Z'));
    expect(got.toISOString()).toBe('2026-07-10T08:00:00.000Z');
  });

  it('handles year rollover', () => {
    const got = nextTenthAtEightUtc(new Date('2026-12-31T12:00:00Z'));
    expect(got.toISOString()).toBe('2027-01-10T08:00:00.000Z');
  });

  it('handles late-night-on-9th (just before deadline)', () => {
    const got = nextTenthAtEightUtc(new Date('2026-06-10T07:59:59.999Z'));
    expect(got.toISOString()).toBe('2026-06-10T08:00:00.000Z');
  });

  it('handles 10th 07:59 UTC → same day 08:00', () => {
    const got = nextTenthAtEightUtc(new Date('2026-06-10T07:00:00Z'));
    expect(got.toISOString()).toBe('2026-06-10T08:00:00.000Z');
  });

  it('handles leap-year February → March crossover', () => {
    // 2028 is a leap year. Feb 11 → next 10th is March 10.
    const got = nextTenthAtEightUtc(new Date('2028-02-11T00:00:00Z'));
    expect(got.toISOString()).toBe('2028-03-10T08:00:00.000Z');
  });

  it('handles January start (month 0)', () => {
    const got = nextTenthAtEightUtc(new Date('2026-01-15T00:00:00Z'));
    expect(got.toISOString()).toBe('2026-02-10T08:00:00.000Z');
  });

  it('returns a UTC instant regardless of the from timezone offset', () => {
    // Even if the input was constructed from a local-time string, the
    // result should land on 08:00 UTC.
    const got = nextTenthAtEightUtc(new Date(Date.UTC(2026, 5, 9, 23, 0, 0)));
    expect(got.getUTCHours()).toBe(8);
    expect(got.getUTCMinutes()).toBe(0);
    expect(got.getUTCSeconds()).toBe(0);
    expect(got.getUTCDate()).toBe(10);
  });
});
