/**
 * Expiration utilities.
 *
 * Business rule: ABC Track access always expires on the 10th of a month at
 * 08:00:00 UTC. The "which month" is derived from the client's
 * paid-through date — the next 10th-of-month strictly after `from`.
 *
 * Worked examples (paidThroughDate → expiration):
 *   2026-05-31 23:00 UTC → 2026-06-10 08:00 UTC
 *   2026-06-09 12:00 UTC → 2026-06-10 08:00 UTC
 *   2026-06-10 08:00 UTC → 2026-07-10 08:00 UTC  (strict-after, not equal)
 *   2026-06-30 12:00 UTC → 2026-07-10 08:00 UTC
 *   2026-12-31 12:00 UTC → 2027-01-10 08:00 UTC  (year rollover)
 *
 * UTC throughout — DST cannot move the deadline.
 */
export function nextTenthAtEightUtc(from: Date): Date {
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth(); // 0-indexed
  let candidate = new Date(Date.UTC(year, month, 10, 8, 0, 0, 0));

  if (candidate.getTime() <= from.getTime()) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    candidate = new Date(Date.UTC(year, month, 10, 8, 0, 0, 0));
  }
  return candidate;
}
