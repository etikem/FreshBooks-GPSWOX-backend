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

interface ConfigWithRetryFlag extends InternalAxiosRequestConfig {
  [RETRY_FLAG]?: boolean;
}

export function createHttpClient(opts: HttpClientOptions): AxiosInstance {
  const client = axios.create({
    baseURL: opts.baseURL,
    timeout: opts.timeoutMs,
    headers: { 'content-type': 'application/json', ...opts.defaultHeaders },
  });

  // ── Request interceptor ────────────────────────────────────────────────
  // Logs every outbound request. If `getAuthHeader` is configured, lazily
  // inject the Authorization header here so token rotation is picked up
  // without rebuilding the client.
  client.interceptors.request.use(async (cfg) => {
    if (opts.getAuthHeader) {
      const auth = await opts.getAuthHeader();
      cfg.headers.set('Authorization', auth);
    }
    logger.debug({ name: opts.name, method: cfg.method, url: cfg.url }, 'http.request');
    return cfg;
  });

  // ── Response interceptor #1: 401 refresh + retry ──────────────────────
  // Registered FIRST so it sees the raw 401 before the error-mapping
  // interceptor wraps it as PermanentHttpError. Only active when the
  // caller supplied an `onUnauthorized` hook.
  if (opts.onUnauthorized) {
    client.interceptors.response.use(
      (res) => res,
      async (err: AxiosError) => {
        const status = err.response?.status;
        const original = err.config as ConfigWithRetryFlag | undefined;

        if (status !== 401 || !original) return Promise.reject(err);

        if (original[RETRY_FLAG]) {
          // Already tried once. The new token also got rejected — this is no
          // longer a token-staleness problem (revoked grant, scope, etc.).
          // Fall through to the error mapper.
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
          // Refresh itself failed. Surface the refresh failure (more
          // actionable than the original 401) and let it flow through.
          return Promise.reject(refreshErr);
        }

        logger.info(
          { name: opts.name, url: original.url, method: original.method },
          'http.401_retrying',
        );

        // The request interceptor will pull the freshly-rotated token and
        // overwrite the stale Authorization header automatically.
        return client.request(original);
      },
    );
  }

  // ── Response interceptor #2: error mapping ────────────────────────────
  // Registered AFTER the 401-retry handler, so by the time we get here a
  // 401 has either been retried successfully (and we see the success
  // response) or has been retried and still failed (and we wrap it).
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
