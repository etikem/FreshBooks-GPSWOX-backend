/**
 * freshbooks.service.js
 * ---------------------
 * Authenticated HTTP client for the FreshBooks API.
 *
 * Design:
 *   - One shared axios instance with a request interceptor that injects the
 *     current access token from token.service.
 *   - A response interceptor that, on 401 Unauthorized, transparently:
 *       1. Calls refreshFreshbooksToken()
 *       2. Persists the new token pair (handled inside token.service)
 *       3. Retries the original request exactly once with the new token
 *   - A `freshbooksRequest()` helper for typed consumers.
 *   - A high-level `getMe()` example.
 *
 * Why retry only ONCE on 401?
 *   If the refresh succeeded but the retried request still 401s, the problem
 *   is no longer "token expired" — it's a permission issue, a malformed
 *   request, or FreshBooks has invalidated the grant. Retrying again would
 *   just hammer the API and burn refresh tokens. Fail fast and let the
 *   caller decide.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const {
  getAccessToken,
  refreshFreshbooksToken,
} = require('./token.service');

const FRESHBOOKS_API_BASE = 'https://api.freshbooks.com';

// Marker we set on retried requests so the response interceptor doesn't
// loop forever if the second attempt also returns 401.
const RETRY_FLAG = '__fb_retried';

const http = axios.create({
  baseURL: FRESHBOOKS_API_BASE,
  timeout: 20_000,
  headers: {
    'Api-Version': 'alpha',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// ---------------------------------------------------------------------------
// Request interceptor — inject Authorization header on every request.
// We set it here (not at instance creation) so the token can rotate at
// runtime without having to rebuild the client.
// ---------------------------------------------------------------------------
http.interceptors.request.use((config) => {
  const token = getAccessToken();
  config.headers = config.headers || {};
  config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ---------------------------------------------------------------------------
// Response interceptor — auto-refresh + retry-once on 401.
// ---------------------------------------------------------------------------
http.interceptors.response.use(
  // Pass-through for successful responses.
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response?.status;

    // Only handle 401 from the FreshBooks API. Other errors bubble up.
    if (status !== 401 || !original) {
      return Promise.reject(error);
    }

    // Don't retry the same request twice — prevents infinite loops if the
    // refreshed token is also rejected (e.g. revoked grant).
    if (original[RETRY_FLAG]) {
      logger.warn('freshbooks.401.after_retry', {
        url: original.url,
        method: original.method,
      });
      return Promise.reject(error);
    }
    original[RETRY_FLAG] = true;

    logger.warn('freshbooks.401.refreshing', {
      url: original.url,
      method: original.method,
    });

    try {
      // refreshFreshbooksToken() handles concurrency internally — many
      // simultaneous 401s share one underlying refresh call.
      await refreshFreshbooksToken();
    } catch (refreshErr) {
      // Refresh itself failed. Surface the original 401 plus the refresh
      // failure so the caller has full context.
      logger.error('freshbooks.401.refresh_failed', {
        message: refreshErr.message,
        code: refreshErr.code,
      });
      return Promise.reject(refreshErr);
    }

    logger.info('freshbooks.401.retrying', {
      url: original.url,
      method: original.method,
    });

    // The request interceptor will pull the freshly-rotated access token
    // and re-attach it to the Authorization header automatically.
    return http(original);
  }
);

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Generic authenticated request helper. Use this for any FreshBooks endpoint
 * not covered by a named method below.
 *
 * Example:
 *   const data = await freshbooksRequest({
 *     method: 'GET',
 *     url: '/auth/api/v1/users/me',
 *   });
 */
async function freshbooksRequest({ method = 'GET', url, params, data, headers } = {}) {
  if (!url) throw new Error('freshbooksRequest: `url` is required');
  const res = await http.request({ method, url, params, data, headers });
  return res.data;
}

/**
 * Example call: GET https://api.freshbooks.com/auth/api/v1/users/me
 * Returns the FreshBooks identity record for the authorized user.
 */
async function getMe() {
  return freshbooksRequest({ method: 'GET', url: '/auth/api/v1/users/me' });
}

module.exports = {
  http, // exported in case callers want raw axios access
  freshbooksRequest,
  getMe,
};
