-- OAuth token store. One row per provider; FreshBooks refresh-token rotation
-- means we must persist the rotated pair before the next API call, otherwise
-- a process restart between "refreshed" and "used" locks us out.
--
-- All nodes in a multi-node deployment must read+write this same row, and
-- the refresh itself is serialized via pg_advisory_lock keyed on the
-- provider name. See backend/src/utils/pg-lock.ts.
CREATE TABLE "oauth_tokens" (
    "provider"      TEXT PRIMARY KEY,
    "access_token"  TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at"    TIMESTAMPTZ(3),
    "updated_at"    TIMESTAMPTZ(3) NOT NULL,
    "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
