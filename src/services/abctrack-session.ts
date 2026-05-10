import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import http from 'http';
import https from 'https';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { PermanentHttpError, TransientHttpError } from '../utils/http';

/**
 * Abctrack uses Laravel-style session auth (cookies + CSRF). This module
 * owns the cookie jar and the X-XSRF-TOKEN header for the whole process,
 * exposes a low-level `request()` helper that callers use, and
 * transparently re-logs-in once when the server returns 401 or 419.
 *
 * Cookies we care about:
 *   - laravel_session   (the session id)
 *   - XSRF-TOKEN        (URL-encoded; the URL-decoded value is the
 *                        X-XSRF-TOKEN header value)
 *   - remember_web_*    (long-lived; only present when remember_me=1)
 *   - any other Set-Cookie the server hands us — we pass them all back
 *
 * Concurrency: a webhook burst on an expired session must not start N
 * parallel logins. `loginPromise` is a single-flight latch — every
 * caller that hits the latch awaits the same in-flight login.
 */

interface CookieJar {
  // Cookie name → raw cookie string value (URL-encoded as the server sent it).
  cookies: Map<string, string>;
}

const jar: CookieJar = { cookies: new Map() };
let loginPromise: Promise<void> | null = null;
let lastLoginAt = 0;

// Some Laravel installs return 419 on token mismatch instead of 401. Both
// signal "your session is gone" — we re-auth in either case.
const SESSION_EXPIRED_STATUSES = new Set([401, 419]);

/**
 * Bare HTTP client — no auto-cookie injection, used only for the login
 * roundtrip. Rest of the codebase goes through `request()`.
 *
 * `validateStatus` allows up to 4xx so we can surface auth failures
 * cleanly instead of throwing inside axios.
 */
const rawClient: AxiosInstance = axios.create({
  baseURL: env.ABCTRACK_API_BASE,
  timeout: env.ABCTRACK_HTTP_TIMEOUT_MS,
  // Abctrack is HTTP not HTTPS in the example. Allow self-signed in case
  // they run a TLS variant with a non-public cert.
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  maxRedirects: 0,
  validateStatus: (s) => s < 500,
});

function parseSetCookieHeader(setCookie: string[] | undefined): void {
  if (!setCookie) return;
  for (const raw of setCookie) {
    // "name=value; Path=/; HttpOnly" — only the leading name=value pair
    // is the cookie itself, the rest are attributes.
    const semi = raw.indexOf(';');
    const head = semi >= 0 ? raw.slice(0, semi) : raw;
    const eq = head.indexOf('=');
    if (eq <= 0) continue;
    const name = head.slice(0, eq).trim();
    const value = head.slice(eq + 1).trim();
    if (!name) continue;
    // Drop the cookie when value is empty (server clearing it).
    if (!value) {
      jar.cookies.delete(name);
      continue;
    }
    jar.cookies.set(name, value);
  }
}

function cookieHeader(): string | undefined {
  if (jar.cookies.size === 0) return undefined;
  return Array.from(jar.cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * The X-XSRF-TOKEN header value is the URL-decoded XSRF-TOKEN cookie.
 * Laravel encodes the cookie value (the trailing `=` becomes `%3D` etc.)
 * so callers MUST decode before sending the header back.
 */
function csrfHeader(): string | undefined {
  const raw = jar.cookies.get('XSRF-TOKEN');
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Build the full default headers attached to every authenticated request.
 * X-Requested-With makes Laravel return JSON validation errors instead of
 * HTML redirects on a CSRF mismatch.
 */
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
  };
  const cookies = cookieHeader();
  if (cookies) h.Cookie = cookies;
  const csrf = csrfHeader();
  if (csrf) h['X-XSRF-TOKEN'] = csrf;
  return h;
}

/** Force-clear the jar — used by tests and on hard re-login. */
export function clearAbctrackSession(): void {
  jar.cookies.clear();
  loginPromise = null;
  lastLoginAt = 0;
}

/**
 * Authenticate against Abctrack. Single-flight: concurrent callers share
 * one in-flight login. We always run a fresh login (we don't try to
 * "refresh" a stale session) — Laravel sessions don't support that pattern.
 */
export async function login(): Promise<void> {
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    // Build URLSearchParams for the login body. The brief mentions
    // multipart/form-data, but Laravel auth controllers accept x-www-form
    // -urlencoded equally well and it's far simpler to send. If a future
    // Abctrack version starts requiring multipart, switch the encoding here
    // — no other layer of the app cares.
    const body = new URLSearchParams();
    body.set('identifier', env.ABCTRACK_EMAIL);
    body.set('password', env.ABCTRACK_PASSWORD);
    body.set('remember_me', '1');
    body.set('_method', 'post');

    // Drop any prior cookies BEFORE the call — login is the only request
    // we explicitly want stateless.
    jar.cookies.clear();

    // Step 1 — Laravel CSRF bootstrap. A naked POST is rejected by the
    // VerifyCsrfToken middleware (returns the generic "Whoops" exception
    // page in JSON when X-Requested-With is set). We first GET the login
    // form page so the server hands us XSRF-TOKEN + laravel_session
    // cookies, then we send the decoded XSRF token as X-XSRF-TOKEN on the
    // POST. ABC Track uses two distinct URLs for these two steps.
    try {
      const bootstrapRes = await rawClient.get(env.ABCTRACK_LOGIN_PAGE_PATH, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      parseSetCookieHeader(bootstrapRes.headers['set-cookie']);
    } catch (err) {
      const ax = err as AxiosError;
      if (!ax.response) {
        throw new TransientHttpError(
          `abctrack login network error: ${ax.message}`,
        );
      }
      // 4xx on the bootstrap GET isn't fatal — some apps redirect or
      // return an error page yet still set the XSRF cookie. Continue.
    }

    // Step 2 — POST the credentials with the matching CSRF header.
    // Laravel's CSRF middleware on session-based apps checks both the
    // cookie/header pair AND (when present) the Origin / Referer against
    // the configured app URL. We set both to the same origin so a
    // strict-mode install doesn't reject us.
    const xsrf = csrfHeader();
    const cookies = cookieHeader();
    const origin = env.ABCTRACK_API_BASE;

    let res: AxiosResponse;
    try {
      res = await rawClient.post(env.ABCTRACK_LOGIN_PATH, body.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: origin,
          Referer: `${origin}${env.ABCTRACK_LOGIN_PAGE_PATH}`,
          ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}),
          ...(cookies ? { Cookie: cookies } : {}),
        },
      });
    } catch (err) {
      const ax = err as AxiosError;
      if (!ax.response) {
        throw new TransientHttpError(
          `abctrack login network error: ${ax.message}`,
        );
      }
      throw err;
    }

    parseSetCookieHeader(res.headers['set-cookie']);

    // Sanity check — we MUST have at least laravel_session after login.
    if (!jar.cookies.has('laravel_session')) {
      const status = res.status;
      const reason =
        typeof res.data === 'object' && res.data && 'message' in res.data
          ? (res.data as { message?: unknown }).message
          : `status=${status}`;
      throw new PermanentHttpError(
        `abctrack login did not return a session cookie (${reason}). ` +
          `Check ABCTRACK_EMAIL / ABCTRACK_PASSWORD.`,
        status,
      );
    }
    lastLoginAt = Date.now();
    logger.info({ at: new Date(lastLoginAt).toISOString() }, 'abctrack.login.ok');
  })();

  try {
    await loginPromise;
  } finally {
    // Either way, clear the latch so the next 401 can trigger a fresh login.
    loginPromise = null;
  }
}

/**
 * Authenticated request helper. All Abctrack callers go through this.
 *
 *   - Auto-injects Cookie + X-XSRF-TOKEN.
 *   - On 401/419 with no prior re-auth: logs in once, retries once.
 *   - On 5xx / network: throws TransientHttpError (the existing retry
 *     queue picks it up).
 *   - On other 4xx: throws PermanentHttpError.
 */
export async function request<T = unknown>(opts: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
  /** Caller can disable auto-relogin (e.g. for tests). Default true. */
  autoRelogin?: boolean;
  /** Internal — set when this is already the retry attempt. */
  _isRetry?: boolean;
}): Promise<AxiosResponse<T>> {
  if (jar.cookies.size === 0 && !opts._isRetry) {
    await login();
  }

  let res: AxiosResponse<T>;
  try {
    res = await rawClient.request<T>({
      method: opts.method,
      url: opts.url,
      params: opts.params,
      data: opts.data,
      headers: { ...authHeaders(), ...(opts.headers ?? {}) },
    });
  } catch (err) {
    const ax = err as AxiosError;
    if (!ax.response) {
      throw new TransientHttpError(
        `abctrack ${opts.method} ${opts.url} network error: ${ax.message}`,
      );
    }
    throw err;
  }

  // Capture cookie rotation (Laravel rotates XSRF-TOKEN on each request).
  parseSetCookieHeader(res.headers['set-cookie']);

  if (SESSION_EXPIRED_STATUSES.has(res.status)) {
    if (opts._isRetry || opts.autoRelogin === false) {
      throw new PermanentHttpError(
        `abctrack ${opts.method} ${opts.url} returned ${res.status} after re-auth attempt`,
        res.status,
        res.data,
      );
    }
    logger.warn(
      { url: opts.url, method: opts.method, status: res.status },
      'abctrack.session.expired — re-auth',
    );
    await login();
    return request<T>({ ...opts, _isRetry: true });
  }

  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    throw new TransientHttpError(
      `abctrack ${opts.method} ${opts.url} ${res.status}`,
      res.status,
    );
  }
  if (res.status >= 400) {
    // Surface the body in the message so 422 validation errors show the
    // failing field names in the action log without the operator having
    // to dig into the .body field at runtime. Truncated to keep the row
    // readable.
    let preview = '';
    try {
      const raw =
        typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      if (raw && raw !== '{}') {
        preview = ` ${raw.length > 500 ? raw.slice(0, 500) + '…' : raw}`;
      }
    } catch {
      /* non-serialisable body — just skip the preview */
    }
    throw new PermanentHttpError(
      `abctrack ${opts.method} ${opts.url} ${res.status}${preview}`,
      res.status,
      res.data,
    );
  }
  return res;
}

/** Diagnostics for /health/abctrack or admin debug endpoints. */
export function sessionInfo(): { loggedIn: boolean; lastLoginAt: number; cookieCount: number } {
  return {
    loggedIn: jar.cookies.has('laravel_session'),
    lastLoginAt,
    cookieCount: jar.cookies.size,
  };
}
