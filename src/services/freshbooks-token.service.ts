/**
 * FreshBooks OAuth token service.
 *
 * Responsibilities:
 *   1. Bootstrap the `oauth_tokens` row from .env on first boot.
 *   2. Hand out the current access token to the HTTP layer (cached in memory).
 *   3. Atomically rotate the access+refresh pair on demand, coordinating
 *      across multiple nodes via a Postgres advisory lock.
 *
 * Coordination model:
 *
 *      ┌─ node A ─┐         ┌─ node B ─┐         ┌─ node C ─┐
 *      │  401     │         │  401     │         │  401     │
 *      │  ↓       │         │  ↓       │         │  ↓       │
 *      │  acquire │── wait──│  acquire │── wait──│  acquire │
 *      │  POST    │         │          │         │          │
 *      │  /oauth  │         │          │         │          │
 *      │  ↓       │         │          │         │          │
 *      │  UPDATE  │         │          │         │          │
 *      │  COMMIT  │── go ──▶│  re-read │── go ──▶│  re-read │
 *      │          │         │  fresh!  │         │  fresh!  │
 *      │          │         │  return  │         │  return  │
 *      └──────────┘         └──────────┘         └──────────┘
 *
 *   Only node A actually calls FreshBooks. B and C, after waking up, see that
 *   the row's `updatedAt` advanced past the timestamp they captured before
 *   asking for the lock — meaning another node already rotated — and use that
 *   result instead of refreshing again. This is the critical correctness
 *   property: if every node refreshed independently, each rotation would
 *   invalidate the previous nodes' refresh tokens and the cluster would
 *   spiral into `invalid_grant`.
 */

import axios from 'axios';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { withAdvisoryLock } from '../utils/pg-lock';

const PROVIDER = 'freshbooks';
const LOCK_NAME = `oauth-refresh:${PROVIDER}`;

// In-memory cache. Populated by `loadTokens()` at boot and refreshed
// whenever we read or rotate the row. A short TTL keeps us close to the DB
// truth without a DB hit on every API call.
interface TokenCache {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  // The DB row's updatedAt at the time we cached it. Used to detect
  // "another node rotated" inside the advisory-lock critical section.
  rowUpdatedAt: Date;
  cachedAt: number; // Date.now() when we wrote this cache entry
}

let cache: TokenCache | null = null;

// Hot-path cache TTL. After this, getAccessToken() rereads from the DB so
// we pick up rotations performed by other nodes without waiting for a 401.
const CACHE_TTL_MS = 30_000;

// In-process refresh coalescing. If 50 in-flight requests all 401 at once on
// THIS node, we want one OAuth call, not 50 — even before the cross-node lock
// kicks in. (The lock would serialize them but each would still do a DB read.)
let inflightRefresh: Promise<TokenCache> | null = null;

/**
 * Public shape returned by `refreshFreshbooksToken()`. Matches the OAuth
 * response keys the user asked for in the original spec.
 */
export interface RefreshedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number | null;
}

// ---------------------------------------------------------------------------
// Boot / read path
// ---------------------------------------------------------------------------

/**
 * Ensure the oauth_tokens row exists, seeding from .env on first boot.
 * Safe to call repeatedly — the seed is idempotent.
 *
 * Call once during process startup so a missing row fails fast at boot
 * rather than on the first API call.
 */
export async function loadTokens(): Promise<void> {
  const existing = await prisma.oauthToken.findUnique({
    where: { provider: PROVIDER },
  });

  if (existing) {
    cache = toCache(existing);
    logger.info(
      { provider: PROVIDER, expiresAt: existing.expiresAt },
      'freshbooks.token.loaded',
    );
    return;
  }

  // First-run bootstrap. Insert the env-supplied pair so the rest of the
  // app can read uniformly from the DB. After the next refresh, these
  // env values are irrelevant — the DB row is authoritative.
  const seeded = await prisma.oauthToken.create({
    data: {
      provider: PROVIDER,
      accessToken: env.FRESHBOOKS_API_TOKEN,
      refreshToken: env.FRESHBOOKS_API_REFRESH_TOKEN,
      expiresAt: null,
    },
  });
  cache = toCache(seeded);
  logger.warn(
    { provider: PROVIDER },
    'freshbooks.token.bootstrapped_from_env',
  );
}

/**
 * Return the access token for outbound API calls. Reads from the in-memory
 * cache when fresh; otherwise re-reads the DB so we pick up cross-node
 * rotations transparently.
 */
export async function getAccessToken(): Promise<string> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.accessToken;
  }

  let row;
  try {
    row = await prisma.oauthToken.findUnique({
      where: { provider: PROVIDER },
    });
  } catch (err) {
    // The DB read is only here to pick up cross-node rotations — the access
    // token we already hold is valid for far longer than the 30s TTL. A
    // transient DB outage (e.g. Render dropping the connection mid-sweep)
    // must NOT fail every outbound FreshBooks call. Serve the cached token
    // and push the next DB re-read out by one TTL window so we don't hammer
    // an unreachable DB on every request. If our token has genuinely been
    // rotated away, the call will 401 and the refresh path takes over.
    if (cache) {
      cache.cachedAt = Date.now();
      logger.warn(
        { err: (err as Error).message },
        'freshbooks.token.read.degraded_serving_cache',
      );
      return cache.accessToken;
    }
    // No cache at all (cold start with the DB down) — nothing we can do.
    throw err;
  }

  if (!row) {
    throw new Error(
      'oauth_tokens row missing for "freshbooks" — call loadTokens() at boot',
    );
  }
  cache = toCache(row);
  return cache.accessToken;
}

// ---------------------------------------------------------------------------
// Refresh path
// ---------------------------------------------------------------------------

/**
 * Exchange the current refresh token for a new pair.
 *
 * Concurrency:
 *   - In-process: a single shared promise (`inflightRefresh`) collapses
 *     parallel callers on the same node into one execution.
 *   - Cross-node: a Postgres advisory lock keyed on "oauth-refresh:freshbooks"
 *     ensures only one node in the cluster makes the OAuth call at any time.
 *     Followers re-read the DB inside the lock and return the freshly-rotated
 *     pair without making a redundant call.
 *
 * Errors:
 *   - HTTP 400/401 from the OAuth endpoint means the refresh token itself is
 *     dead (revoked, replayed, expired). We tag the error with code
 *     REFRESH_TOKEN_INVALID so callers can surface a re-auth prompt.
 *   - Network/5xx errors throw normally — caller may retry.
 */
export async function refreshFreshbooksToken(): Promise<RefreshedTokens> {
  if (inflightRefresh) {
    logger.debug('freshbooks.token.refresh.coalesced_in_process');
    const t = await inflightRefresh;
    return toPublic(t);
  }

  inflightRefresh = (async (): Promise<TokenCache> => {
    try {
      const result = await withAdvisoryLock(LOCK_NAME, async (tx) => {
        // Snapshot what we believed was the latest row before acquiring the
        // lock. We compare this to the row we read INSIDE the lock to detect
        // cross-node rotations that happened while we waited.
        const beforeUpdatedAt = cache?.rowUpdatedAt ?? new Date(0);

        const row = await tx.oauthToken.findUnique({
          where: { provider: PROVIDER },
        });
        if (!row) {
          throw new Error(
            'oauth_tokens row missing for "freshbooks" — call loadTokens() at boot',
          );
        }

        if (row.updatedAt.getTime() > beforeUpdatedAt.getTime()) {
          // Another node refreshed while we were waiting for the lock.
          // Adopt their result — calling FreshBooks now would invalidate
          // the brand-new refresh_token they just persisted.
          logger.info(
            {
              ourSnapshot: beforeUpdatedAt.toISOString(),
              dbUpdatedAt: row.updatedAt.toISOString(),
            },
            'freshbooks.token.refresh.adopted_from_peer',
          );
          return toCache(row);
        }

        // We are the leader for this rotation. Make the OAuth call.
        logger.info('freshbooks.token.refresh.start');
        const oauth = await callOAuthEndpoint(row.refreshToken);

        // Persist the new pair INSIDE the lock + transaction. If this commit
        // fails for any reason, the lock releases on rollback and the next
        // caller will retry — no half-state.
        const updated = await tx.oauthToken.update({
          where: { provider: PROVIDER },
          data: {
            accessToken: oauth.access_token,
            refreshToken: oauth.refresh_token,
            expiresAt: oauth.expires_in
              ? new Date(Date.now() + oauth.expires_in * 1000)
              : null,
          },
        });

        logger.info(
          { expiresAt: updated.expiresAt },
          'freshbooks.token.refresh.success',
        );
        return toCache(updated);
      });

      cache = result;
      return result;
    } finally {
      // Clear the slot so a future call (e.g. after a transient failure) can
      // try again. Always runs — exception path included.
      inflightRefresh = null;
    }
  })();

  const cached = await inflightRefresh;
  return toPublic(cached);
}

/**
 * Force-clear the in-memory cache. Use sparingly — currently called when an
 * authenticated request returns 401 *after* a refresh+retry, so the next call
 * is guaranteed to re-read from the DB.
 */
export function invalidateCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface OAuthResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function callOAuthEndpoint(refreshToken: string): Promise<OAuthResponse> {
  try {
    const res = await axios.post<OAuthResponse>(
      env.FRESHBOOKS_OAUTH_TOKEN_URL,
      {
        grant_type: 'refresh_token',
        client_id: env.FRESHBOOKS_CLIENT_ID,
        client_secret: env.FRESHBOOKS_CLIENT_SECRET,
        refresh_token: refreshToken,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 15_000,
      },
    );

    if (!res.data?.access_token || !res.data?.refresh_token) {
      throw new Error(
        'FreshBooks OAuth response missing access_token or refresh_token',
      );
    }
    return res.data;
  } catch (err) {
    const status =
      (err as { response?: { status?: number } })?.response?.status ?? null;
    const body = (err as { response?: { data?: unknown } })?.response?.data;
    const message = (err as Error).message;

    logger.error(
      { status, body, message },
      'freshbooks.token.refresh.failure',
    );

    // FreshBooks rejected the refresh_token itself. No retry will help —
    // the user must re-authorize and the new pair must be seeded.
    if (status === 400 || status === 401) {
      
      const e = new Error(
        'FreshBooks rejected the refresh token. Re-authorization required.',
      ) as Error & { code?: string; cause?: unknown };
      e.code = 'REFRESH_TOKEN_INVALID';
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

function toCache(row: {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  updatedAt: Date;
}): TokenCache {
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    rowUpdatedAt: row.updatedAt,
    cachedAt: Date.now(),
  };
}

function toPublic(c: TokenCache): RefreshedTokens {
  return {
    access_token: c.accessToken,
    refresh_token: c.refreshToken,
    expires_in: c.expiresAt
      ? Math.max(0, Math.floor((c.expiresAt.getTime() - Date.now()) / 1000))
      : null,
  };
}
