import { Request, Response, NextFunction } from 'express';

/**
 * Tiny in-memory token bucket. Sufficient for a single-instance admin API
 * where the only DOSable surface is /admin/login. If we ever scale out
 * horizontally, replace with a Redis-backed bucket.
 */
interface Bucket {
  tokens: number;
  refilledAt: number;
}

const buckets = new Map<string, Bucket>();
const REFILL_INTERVAL_MS = 60 * 1000; // 1 min

export function rateLimit(opts: { perMinute: number; key?: (req: Request) => string }) {
  const limit = Math.max(1, opts.perMinute);
  const keyFn = opts.key ?? defaultKey;
  return (req: Request, res: Response, next: NextFunction): void => {
    const k = keyFn(req);
    const now = Date.now();
    let b = buckets.get(k);
    if (!b) {
      b = { tokens: limit, refilledAt: now };
      buckets.set(k, b);
    }
    // Refill at the start of each minute window — simpler than continuous
    // and entirely sufficient for human-paced login attempts.
    if (now - b.refilledAt >= REFILL_INTERVAL_MS) {
      b.tokens = limit;
      b.refilledAt = now;
    }
    if (b.tokens <= 0) {
      const retryAfter = Math.ceil((REFILL_INTERVAL_MS - (now - b.refilledAt)) / 1000);
      res.setHeader('retry-after', String(Math.max(retryAfter, 1)));
      res.status(429).json({ error: 'too many requests' });
      return;
    }
    b.tokens -= 1;
    next();
  };
}

function defaultKey(req: Request): string {
  // Use the x-forwarded-for first hop if present (typical reverse-proxy
  // setup), else the direct socket address. Both are best-effort.
  const xff = req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || req.ip || 'unknown';
  return req.ip || 'unknown';
}
