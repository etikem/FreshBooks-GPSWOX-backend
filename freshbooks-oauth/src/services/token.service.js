/**
 * token.service.js
 * -----------------
 * Single source of truth for FreshBooks OAuth tokens.
 *
 * Responsibilities:
 *   1. Load the current access + refresh token from durable storage on boot.
 *      (Falls back to .env values if no store exists yet — a one-time bootstrap.)
 *   2. Expose getters that the HTTP layer uses to attach Authorization headers.
 *   3. Expose `refreshFreshbooksToken()` which exchanges the refresh token for
 *      a new access + refresh token pair, and writes the new pair back to
 *      durable storage IMMEDIATELY.
 *   4. De-duplicate concurrent refresh calls — if 12 requests all hit 401 at
 *      the same time, only one OAuth call should be made.
 *
 * Why a token STORE and not just process.env?
 *   FreshBooks rotates the refresh token on every refresh. The previous
 *   refresh token is invalidated as soon as a new pair is issued. If we only
 *   held tokens in process memory and the process crashed/restarted between
 *   "got new tokens" and "used them", we'd be locked out — the .env still
 *   contains the now-dead refresh token. Persistence prevents that.
 *
 * Production note:
 *   The file-based store here is the simplest correct design. For multi-node
 *   deployments, replace `readStore`/`writeStore` with a Postgres/Redis call,
 *   or a secret-manager (AWS Secrets Manager, GCP Secret Manager, Vault).
 *   The public API of this module stays the same.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../utils/logger');

const TOKEN_URL = 'https://api.freshbooks.com/auth/oauth/token';

// Resolve the store path once at module load.
const STORE_PATH = path.resolve(
  process.env.TOKEN_STORE_PATH || './token-store.json'
);

// In-memory cache of the current token pair. This is the hot path —
// every authenticated API call reads from here.
let cache = null;

// In-flight refresh promise, used to coalesce concurrent refresh attempts
// into a single network call. See `refreshFreshbooksToken` below.
let inflightRefresh = null;

// ---------------------------------------------------------------------------
// Storage driver — swap this section for a DB/secret-store in production.
// ---------------------------------------------------------------------------

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.access_token && parsed.refresh_token) {
      return parsed;
    }
    return null;
  } catch (err) {
    // ENOENT on first run is expected — fall back to env bootstrap.
    if (err.code !== 'ENOENT') {
      logger.warn('token.store.read_failed', { error: err.message });
    }
    return null;
  }
}

function writeStore(tokens) {
  // Write atomically: write to a temp file then rename, so a crash mid-write
  // can't leave us with a half-written JSON file (which would lock us out).
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load tokens into the in-memory cache. Called once at boot, and implicitly
 * by getAccessToken() if the cache is empty.
 *
 * Priority:
 *   1. token-store.json   (most recent rotated pair — authoritative)
 *   2. process.env        (one-time bootstrap on first run)
 */
function loadTokens() {
  const stored = readStore();
  if (stored) {
    cache = stored;
    logger.info('token.loaded_from_store');
    return cache;
  }

  // Bootstrap from env — only happens before the first refresh.
  const envAccess = process.env.FRESHBOOKS_API_TOKEN;
  const envRefresh = process.env.FRESHBOOKS_API_REFRESH_TOKEN;
  if (!envAccess || !envRefresh) {
    throw new Error(
      'No tokens found. Set FRESHBOOKS_API_TOKEN and FRESHBOOKS_API_REFRESH_TOKEN ' +
        'in .env, or provision a token-store.json file.'
    );
  }
  cache = {
    access_token: envAccess,
    refresh_token: envRefresh,
    expires_in: null,
    obtained_at: null,
  };
  // Persist the bootstrap so subsequent reads are uniform.
  writeStore(cache);
  logger.info('token.bootstrapped_from_env');
  return cache;
}

function getAccessToken() {
  if (!cache) loadTokens();
  return cache.access_token;
}

function getRefreshToken() {
  if (!cache) loadTokens();
  return cache.refresh_token;
}

/**
 * Persist a new token pair, both to memory and to durable storage.
 * Storage write happens BEFORE the in-memory swap is acknowledged to the
 * caller — if the disk write fails, we never claim the new tokens are usable.
 */
function setTokens({ access_token, refresh_token, expires_in }) {
  if (!access_token || !refresh_token) {
    throw new Error('setTokens requires both access_token and refresh_token');
  }
  const next = {
    access_token,
    refresh_token,
    expires_in: expires_in ?? null,
    obtained_at: new Date().toISOString(),
  };
  writeStore(next); // durable first
  cache = next; // then memory
  return next;
}

/**
 * Exchange the current refresh token for a new access+refresh pair.
 *
 * Returns: { access_token, refresh_token, expires_in }
 *
 * Concurrency: if multiple callers invoke this simultaneously (typical when
 * many in-flight requests all 401 at once), only ONE network request is made.
 * The rest await the same promise. Without this, we'd burn refresh tokens —
 * FreshBooks would invalidate the old one mid-flight and the second-place
 * refresh would fail with 400 invalid_grant.
 */
async function refreshFreshbooksToken() {
  if (inflightRefresh) {
    logger.debug('token.refresh.coalesced');
    return inflightRefresh;
  }

  inflightRefresh = (async () => {
    const clientId = process.env.FRESHBOOKS_CLIENT_ID;
    const clientSecret = process.env.FRESHBOOKS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'FRESHBOOKS_CLIENT_ID and FRESHBOOKS_CLIENT_SECRET must be set'
      );
    }

    const refresh_token = getRefreshToken();
    logger.info('token.refresh.start');

    try {
      const res = await axios.post(
        TOKEN_URL,
        {
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15_000,
        }
      );

      const data = res.data || {};
      if (!data.access_token || !data.refresh_token) {
        throw new Error(
          'FreshBooks refresh response missing access_token or refresh_token'
        );
      }

      // CRITICAL: persist the new pair IMMEDIATELY. The old refresh_token
      // is now invalid on FreshBooks' side — if we crash before saving,
      // we are locked out and must reauthorize from scratch.
      const saved = setTokens({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
      });

      logger.info('token.refresh.success', {
        expires_in: saved.expires_in,
      });

      return {
        access_token: saved.access_token,
        refresh_token: saved.refresh_token,
        expires_in: saved.expires_in,
      };
    } catch (err) {
      // Surface useful diagnostics. FreshBooks returns JSON like
      // { error: "invalid_grant", error_description: "..." } on failure.
      const status = err.response?.status;
      const body = err.response?.data;
      logger.error('token.refresh.failure', {
        status,
        body,
        message: err.message,
      });

      // If FreshBooks itself rejected the refresh token, no amount of retry
      // will help — the user must re-authorize the app. Fail loudly.
      if (status === 400 || status === 401) {
        const e = new Error(
          'FreshBooks rejected the refresh token. Re-authorization required.'
        );
        e.code = 'REFRESH_TOKEN_INVALID';
        e.cause = err;
        throw e;
      }
      throw err;
    } finally {
      // Clear the in-flight slot whether we succeeded or failed, so the next
      // caller can try again (e.g. transient network failure).
      inflightRefresh = null;
    }
  })();

  return inflightRefresh;
}

module.exports = {
  loadTokens,
  getAccessToken,
  getRefreshToken,
  setTokens,
  refreshFreshbooksToken,
};
