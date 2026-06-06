import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
} from 'axios';
import { logger } from './logger';

export interface HttpClientOptions {
  baseURL: string;
  timeoutMs: number;
  defaultHeaders?: Record<string, string>;
  name: string; // for logs
  /**
   * Optional async provider for the Authorization header value (e.g. a
   * dynamically-rotated OAuth bearer token). When set, the value returned
   * here is injected on every request, overriding any `Authorization`
   * passed in `defaultHeaders`. Errors thrown from the provider abort the
   * request — that's intentional, "we don't have a token" should never
   * silently fall through.
   */
  getAuthHeader?: () => Promise<string> | string;
  /**
   * Optional 401 handler. When the server returns 401 the client will:
   *   1. Call `onUnauthorized()` (typically: refresh the OAuth token).
   *   2. Retry the original request exactly once.
   *   3. If the retried request also 401s, give up and let the error
   *      flow through to the standard error mapper.
   * Wire this to the OAuth refresh path. The handler is responsible for
   * persisting the new token before resolving.
   */
  onUnauthorized?: () => Promise<void>;
  /**
   * Max client-side requests to START per second. The client serialises
   * outbound requests so they're spaced at least 1000/rateLimitPerSec ms
   * apart, proactively staying under the upstream rate limit. Omit/0 to
   * disable throttling.
   */
  rateLimitPerSec?: number;
  /**
   * How many times to retry a rate-limited (429) or transient (5xx/408/
   * network) failure before giving up. Defaults to 3. Retries honour a
   * `Retry-After` header when present, otherwise use exponential backoff
   * with jitter.
   */
  maxRetries?: number;
}

export class TransientHttpError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'TransientHttpError';
  }
}

export class PermanentHttpError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = 'PermanentHttpError';
  }
}

// Marker we set on retried requests so the 401 interceptor doesn't loop.
const RETRY_FLAG = '__http_retried_after_refresh';
// Per-request count of backoff retries already performed (429/5xx/network).
const RETRY_COUNT = '__http_retry_count';

interface ConfigWithRetryFlag extends InternalAxiosRequestConfig {
  [RETRY_FLAG]?: boolean;
  [RETRY_COUNT]?: number;
}

/** Live counters per client, surfaced for run summaries / observability. */
export interface HttpStats {
  /** Total requests sent, including retries. */
  requests: number;
  /** Number of 429 responses observed (each retry counts). */
  rateLimitHits: number;
  /** Number of requests that exhausted all retries and failed. */
  retriesExhausted: number;
}

const statsByClient = new WeakMap<AxiosInstance, HttpStats>();

/** Read the live request stats for a client created by `createHttpClient`. */
export function getHttpStats(client: AxiosInstance): HttpStats {
  return (
    statsByClient.get(client) ?? {
      requests: 0,
      rateLimitHits: 0,
      retriesExhausted: 0,
    }
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a `Retry-After` header. FreshBooks (and RFC 7231) allow either an
 * integer number of seconds or an HTTP date. Returns the delay in ms, or null
 * when the header is absent/unparseable.
 */
function parseRetryAfter(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Exponential backoff with full jitter. attempt is 1-based.
 *   delay = min(cap, base * 2^(attempt-1)) ± jitter
 */
function backoffDelay(attempt: number): number {
  const base = 500;
  const cap = 30_000;
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  const jitter = Math.random() * 0.25 * exp;
  return Math.round(exp - exp * 0.125 + jitter);
}

export function createHttpClient(opts: HttpClientOptions): AxiosInstance {
  const client = axios.create({
    baseURL: opts.baseURL,
    timeout: opts.timeoutMs,
    headers: { 'content-type': 'application/json', ...opts.defaultHeaders },
  });

  const stats: HttpStats = { requests: 0, rateLimitHits: 0, retriesExhausted: 0 };
  statsByClient.set(client, stats);

  const maxRetries = opts.maxRetries ?? 3;

  // ── Client-side throttle ──────────────────────────────────────────────
  // Spaces outbound requests so we start at most `rateLimitPerSec` per
  // second. `nextSlot` is reserved synchronously before any await, so even
  // with N concurrent callers each reservation is unique (single-threaded
  // read-modify-write) and requests queue at fixed intervals.
  const minIntervalMs =
    opts.rateLimitPerSec && opts.rateLimitPerSec > 0
      ? 1000 / opts.rateLimitPerSec
      : 0;
  let nextSlot = 0;
  async function throttle(): Promise<void> {
    if (minIntervalMs <= 0) return;
    const now = Date.now();
    const start = Math.max(now, nextSlot);
    nextSlot = start + minIntervalMs;
    const wait = start - now;
    if (wait > 0) await sleep(wait);
  }

  // ── Request interceptor ────────────────────────────────────────────────
  // Throttle, inject auth, count, log.
  client.interceptors.request.use(async (cfg) => {
    await throttle();
    if (opts.getAuthHeader) {
      const auth = await opts.getAuthHeader();
      cfg.headers.set('Authorization', auth);
    }
    stats.requests += 1;
    logger.debug({ name: opts.name, method: cfg.method, url: cfg.url }, 'http.request');
    return cfg;
  });

  // ── Response interceptor #1: 401 refresh + retry ──────────────────────
  // Registered FIRST so it sees the raw 401 before the rate-limit/error
  // interceptors. Only active when the caller supplied an `onUnauthorized`
  // hook.
  if (opts.onUnauthorized) {
    client.interceptors.response.use(
      (res) => res,
      async (err: AxiosError) => {
        const status = err.response?.status;
        const original = err.config as ConfigWithRetryFlag | undefined;

        if (status !== 401 || !original) return Promise.reject(err);

        if (original[RETRY_FLAG]) {
          logger.warn(
            { name: opts.name, url: original.url, method: original.method },
            'http.401_after_retry',
          );
          return Promise.reject(err);
        }
        original[RETRY_FLAG] = true;

        logger.warn(
          { name: opts.name, url: original.url, method: original.method },
          'http.401_refreshing',
        );

        try {
          await opts.onUnauthorized!();
        } catch (refreshErr) {
          return Promise.reject(refreshErr);
        }

        logger.info(
          { name: opts.name, url: original.url, method: original.method },
          'http.401_retrying',
        );
        return client.request(original);
      },
    );
  }

  // ── Response interceptor #2: rate-limit / transient retry ─────────────
  // Retries 429 (rate limit) and 5xx/408/network errors with backoff,
  // honouring Retry-After. Does NOT handle 401 (that's interceptor #1) or
  // permanent 4xx (those fall through to the error mapper).
  client.interceptors.response.use(
    (res) => res,
    async (err: AxiosError) => {
      const status = err.response?.status;
      const original = err.config as ConfigWithRetryFlag | undefined;
      if (!original) return Promise.reject(err);

      const isRateLimit = status === 429;
      const isTransient = !status || status >= 500 || status === 408;
      if (!isRateLimit && !isTransient) return Promise.reject(err);
      if (status === 401) return Promise.reject(err);

      if (isRateLimit) stats.rateLimitHits += 1;

      const attempt = (original[RETRY_COUNT] ?? 0) + 1;
      if (attempt > maxRetries) {
        stats.retriesExhausted += 1;
        logger.warn(
          { name: opts.name, url: original.url, status, attempts: attempt - 1 },
          'http.retry.exhausted',
        );
        return Promise.reject(err);
      }
      original[RETRY_COUNT] = attempt;

      const retryAfter = parseRetryAfter(err.response?.headers?.['retry-after']);
      const delay = Math.min(
        retryAfter ?? backoffDelay(attempt),
        60_000,
      );

      logger.warn(
        {
          name: opts.name,
          url: original.url,
          status: status ?? 'network',
          attempt,
          maxRetries,
          delayMs: delay,
          retryAfter: retryAfter ?? undefined,
        },
        isRateLimit ? 'http.rate_limited' : 'http.transient_retry',
      );

      await sleep(delay);
      return client.request(original);
    },
  );

  // ── Response interceptor #3: error mapping ────────────────────────────
  // Anything still failing here is out of retries or non-retryable. Wrap it
  // into the typed errors the rest of the app understands.
  client.interceptors.response.use(
    (res) => {
      logger.debug(
        { name: opts.name, status: res.status, url: res.config.url },
        'http.response',
      );
      return res;
    },
    (err: AxiosError) => {
      const status = err.response?.status;
      const body = err.response?.data;
      logger.warn(
        { name: opts.name, status, url: err.config?.url, err: err.message },
        'http.error',
      );
      // Network errors / 5xx / 408 / 429 → transient (retry-eligible).
      if (!status || status >= 500 || status === 408 || status === 429) {
        return Promise.reject(
          new TransientHttpError(`${opts.name} ${status ?? 'network'} error: ${err.message}`, status),
        );
      }
      // 4xx (other than 408/429) → permanent. Do not retry blindly.
      return Promise.reject(
        new PermanentHttpError(
          `${opts.name} ${status} error: ${err.message}`,
          status,
          body,
        ),
      );
    },
  );

  return client;
}

export type { AxiosRequestConfig };
