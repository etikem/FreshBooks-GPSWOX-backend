import 'dotenv/config';
import { z } from 'zod';

// Known placeholders that historically slipped into prod .env files.
// In production we refuse to boot with any of these — better fail loud than
// serve traffic with a default-known signing key. In dev we warn.
const PLACEHOLDER_SECRETS = new Set<string>([
  'change_me_to_a_long_random_string',
  'changeme',
  'replace_me',
  'replace_me_with_a_long_random_string',
  'secret',
  'jwt_secret',
]);

const bcryptHash = z
  .string()
  .min(20, 'ADMIN_PASSWORD_HASH must be a bcrypt hash')
  .refine(
    (v) => /^\$2[aby]\$/.test(v),
    'ADMIN_PASSWORD_HASH must start with $2a$, $2b$, or $2y$ (bcrypt format). ' +
      'Generate with: node -e "console.log(require(\'bcryptjs\').hashSync(\'pw\',12))"',
  );

const isProd = process.env.NODE_ENV === 'production';

// Production: strict — reject placeholders, require ≥ 32 chars.
// Dev: lenient — allow short/placeholder but warn at boot.
const jwtSecret = isProd
  ? z
      .string()
      .min(32, 'JWT_SECRET must be at least 32 characters in production')
      .refine(
        (v) => !PLACEHOLDER_SECRETS.has(v),
        'JWT_SECRET appears to still be the example placeholder. ' +
          'Generate a real one: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
      )
  : z.string().min(16);

/**
 * The FreshBooks webhook secret accepts two shapes:
 *
 *   1. A plain string — one verifier shared across every event.
 *   2. A JSON object — `{ "<event.type>": "<verifier>", ... }` where
 *      FreshBooks issued a different verifier per registered callback.
 *
 * Internally we always normalise to the map form. Plain strings become
 * `{ default: "<value>" }` and lookups fall back to that key when an
 * event-specific entry is missing.
 */
export type WebhookSecretMap = Readonly<Record<string, string>>;

const webhookSecret = z
  .string()
  .min(8)
  .transform((raw, ctx): WebhookSecretMap => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'FRESHBOOKS_WEBHOOK_SECRET looks like JSON but failed to parse',
        });
        return z.NEVER;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'FRESHBOOKS_WEBHOOK_SECRET JSON must be a flat object of "<event.type>": "<secret>"',
        });
        return z.NEVER;
      }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== 'string' || v.length < 8) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `FRESHBOOKS_WEBHOOK_SECRET["${k}"] must be a string of at least 8 chars`,
          });
          return z.NEVER;
        }
        out[k.toLowerCase()] = v;
      }
      if (Object.keys(out).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'FRESHBOOKS_WEBHOOK_SECRET JSON object must have at least one entry',
        });
        return z.NEVER;
      }
      return Object.freeze(out);
    }
    return Object.freeze({ default: trimmed });
  });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),

  FRESHBOOKS_CLIENT_ID: z.string().min(1),
  FRESHBOOKS_CLIENT_SECRET: z.string().min(1),
  FRESHBOOKS_API_TOKEN: z.string().min(1),
  FRESHBOOKS_API_REFRESH_TOKEN: z.string().min(1),
  FRESHBOOKS_ACCOUNT_ID: z.string().min(1),
  FRESHBOOKS_BUSINESS_ID: z.string().min(1),
  FRESHBOOKS_API_BASE: z.string().url().default('https://api.freshbooks.com'),
  FRESHBOOKS_OAUTH_TOKEN_URL: z
    .string()
    .url()
    .default('https://api.freshbooks.com/auth/oauth/token'),
  FRESHBOOKS_WEBHOOK_SECRET: webhookSecret,

  // ── FreshBooks rate-limit / pagination tuning ────────────────────────
  // Proactive client-side throttle: the max number of outbound FreshBooks
  // requests we start per second. Kept below FreshBooks' server limit so a
  // bulk sweep never trips 429 in the first place. The HTTP client spaces
  // requests by 1000/rps ms.
  FRESHBOOKS_RATE_LIMIT_RPS: z.coerce.number().positive().max(50).default(5),
  // How many times to retry a 429/5xx/network failure before giving up.
  // Backoff honours the server's Retry-After header when present, else uses
  // exponential backoff with jitter.
  FRESHBOOKS_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(5),
  // Page size for paginated list endpoints (clients, invoices). 100 is the
  // FreshBooks maximum and minimises the number of round-trips.
  FRESHBOOKS_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(100),
  // When the reconciliation sweep bulk-fetches invoices, only pull invoices
  // created within this many days. Device quantity comes from each client's
  // LATEST invoice, and active clients are billed monthly, so a few months is
  // ample — this keeps the bulk fetch small. Set 0 to fetch all invoices.
  FRESHBOOKS_INVOICE_LOOKBACK_DAYS: z.coerce.number().int().min(0).default(180),

  // ABC Track (live.abctrack.net) — Laravel-session-authenticated admin UI
  // backend. Email + password are required (the session layer logs in
  // lazily); the rest default to the paths/timeouts the live deployment
  // uses today.
  //
  // The transform strips trailing whitespace/commas/slashes — `new URL()`
  // accepts these but axios then concatenates `<base><path>` literally and
  // the resulting string isn't a valid URL anymore. We've been bitten by
  // a stray trailing comma in .env once already.
  ABCTRACK_API_BASE: z
    .string()
    .url()
    .transform((v) => v.trim().replace(/[/,\s]+$/, '')),
  ABCTRACK_EMAIL: z.string().email(),
  ABCTRACK_PASSWORD: z.string().min(1),
  // ABC Track splits its session login into two URLs: the GET that hands
  // out the XSRF-TOKEN cookie, and the POST that actually authenticates.
  ABCTRACK_LOGIN_PAGE_PATH: z.string().min(1).default('/ui/auth/login'),
  ABCTRACK_LOGIN_PATH: z.string().min(1).default('/ui/authentication/store'),
  // Admin client endpoints — `BASE` is used for create (POST), update
  // (POST + _method=put on /{id}), and delete (DELETE on /{id}). `LIST`
  // is the table-payload endpoint used for email lookup.
  ABCTRACK_ENDPOINT_CLIENT_BASE: z.string().min(1).default('/ui/admin/client'),
  ABCTRACK_ENDPOINT_CLIENT_LIST: z
    .string()
    .min(1)
    .default('/ui/payload/table/admin/client/client'),
  // Per-client form payload — GET /{id} returns first_name/last_name/email/
  // phone_number for a single client. Used by the reconciliation sweep to
  // enrich "missing in FreshBooks" rows the listing doesn't carry by name.
  ABCTRACK_ENDPOINT_CLIENT_FORM: z
    .string()
    .min(1)
    .default('/ui/admin/form/client/client'),
  ABCTRACK_LIST_PER_PAGE: z.coerce.number().int().positive().max(500).default(100),
  ABCTRACK_LIST_MAX_PAGES: z.coerce.number().int().positive().default(200),
  ABCTRACK_EMAIL_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(5 * 60_000),
  ABCTRACK_EMAIL_NEG_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(60_000),
  ABCTRACK_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  JWT_SECRET: jwtSecret,
  ADMIN_USERNAME: z.string().min(1),
  ADMIN_PASSWORD_HASH: bcryptHash,

  RETRY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

  // Optional knobs
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  CATCHUP_SWEEP_ON_BOOT: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .transform((v) => v === 'true' || v === '1')
    .default('true'),
  CRON_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  // Run the access-expiry cron sweep from the API process too, not only the
  // retry worker. Defaults ON so a web-only deployment (no separate worker
  // dyno) still blocks clients whose access window elapsed. Safe to leave on
  // even when the worker runs — the sweep is idempotent. Set to "false" only
  // if you run a dedicated worker and want to avoid the redundant timer.
  CRON_SWEEP_IN_API: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .transform((v) => v === 'true' || v === '1')
    .default('true'),

  // ── Reconciliation sweep (ABC Track ↔ FreshBooks discrepancy report) ──
  // Name of the FreshBooks invoice line item that carries the per-device
  // billing quantity. The sweep sums the qty of every line whose name
  // matches this (case-insensitive) on a client's latest invoice and
  // compares it to ABC Track's devices_count.
  RECONCILE_DEVICE_LINE_NAME: z.string().min(1).default('GPS Monthly Fee'),
  // How many ABC Track clients to reconcile against FreshBooks in parallel.
  // Kept modest so we don't trip FreshBooks rate limits on a full sweep.
  RECONCILE_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),

  // Retain processed (non-failed) WebhookEvent rows for this many days.
  // Failed rows are NEVER auto-pruned — operators triage them manually.
  WEBHOOK_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  NOTIFICATION_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

// Dev-only warnings (logger isn't ready yet — use console).
if (!isProd && PLACEHOLDER_SECRETS.has(env.JWT_SECRET)) {
  console.warn(
    '[env] WARNING: JWT_SECRET is a placeholder. Tokens issued in this dev ' +
      'session are predictable. Generate a real one before deploying.',
  );
}

/**
 * Resolve the webhook verifier for a given event type.
 *
 * Lookup order:
 *   1. Exact (lowercased) match on the event type, e.g. "invoice.create".
 *   2. The "default" key — populated automatically when the env var was a
 *      plain string, or set explicitly inside the JSON map as a fallback.
 *
 * Returns `null` when no entry matches; the caller MUST treat that as an
 * authentication failure rather than skipping the check.
 */
export function getWebhookSecretForEvent(eventType: string | undefined): string | null {
  const map = env.FRESHBOOKS_WEBHOOK_SECRET;
  if (eventType) {
    const hit = map[eventType.toLowerCase()];
    if (hit) return hit;
  }
  return map.default ?? null;
}

/**
 * Every secret currently configured. Used by the HMAC fallback path which
 * doesn't know the event type until after the body is verified, and by
 * tests that need to round-trip a known secret.
 */
export function getAllWebhookSecrets(): readonly string[] {
  return Object.values(env.FRESHBOOKS_WEBHOOK_SECRET);
}
