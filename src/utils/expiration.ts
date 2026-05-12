/**
 * Expiration utility — payment-driven.
 *
 * Business rule: a successful payment in month M grants ABC Track access
 * through the 10th of month M+1 at 08:00:00 UTC. The "month" is taken from
 * the payment's UTC wall-clock date.
 *
 * Worked examples (paymentDate → expiration):
 *   2026-04-02         → 2026-05-10 08:00 UTC
 *   2026-04-12         → 2026-05-10 08:00 UTC
 *   2026-05-30         → 2026-06-10 08:00 UTC
 *   2026-12-15         → 2027-01-10 08:00 UTC  (year rollover)
 *   2026-01-31 23:59 UTC → 2026-02-10 08:00 UTC
 *
 * UTC throughout — DST cannot move the deadline.
 */
export function nextMonthTenthAtEightUtc(paymentDate: Date): Date {
  const year = paymentDate.getUTCFullYear();
  const month = paymentDate.getUTCMonth(); // 0-indexed
  return new Date(Date.UTC(year, month + 1, 10, 8, 0, 0, 0));
}
