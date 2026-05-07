import Decimal from 'decimal.js';

// Configure once: 28 significant digits, banker's rounding.
// Currency math must never use Number arithmetic.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type Money = Decimal;

/**
 * Parse anything coming back from FreshBooks/Prisma into a safe Decimal.
 * Returns null when the value is missing/unparseable — callers MUST treat
 * null as "ambiguous" (i.e. BLOCK) rather than coercing to zero.
 */
export function toMoney(value: unknown): Money | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Decimal) return value;
  // Prisma Decimal type exposes .toString(); also handles Number/string.
  try {
    const d = new Decimal(value as Decimal.Value);
    if (!d.isFinite()) return null;
    return d;
  } catch {
    return null;
  }
}

export const ZERO: Money = new Decimal(0);

export function isZero(m: Money): boolean {
  return m.isZero();
}

export function isPositive(m: Money): boolean {
  return m.greaterThan(0);
}

export function sum(values: ReadonlyArray<Money>): Money {
  return values.reduce<Money>((acc, v) => acc.plus(v), ZERO);
}

/**
 * Format for display / logs. Always 2 decimals. Never used for math.
 */
export function format(m: Money): string {
  return m.toFixed(2);
}
