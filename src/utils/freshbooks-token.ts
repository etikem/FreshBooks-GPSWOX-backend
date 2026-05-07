import { logger } from './logger';

/**
 * Decode the `exp` claim from a JWT bearer token without verifying the
 * signature. We don't have FreshBooks' public key, and we're not making
 * trust decisions — we just want to surface "token is expired" at boot
 * so the operator isn't chasing 20-second timeouts and 401s.
 */
function readJwtExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export function checkFreshbooksTokenAtStartup(token: string): void {
  const exp = readJwtExp(token);
  if (exp === null) {
    // Not a JWT (or unparseable) — could be a long-lived PAT. Skip silently.
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const secondsLeft = exp - now;

  if (secondsLeft <= 0) {
    logger.error(
      { expiredAgoSeconds: -secondsLeft, expiresAt: new Date(exp * 1000).toISOString() },
      'FRESHBOOKS_API_TOKEN is EXPIRED — every FreshBooks call will return 401. ' +
        'Refresh the token in FreshBooks Developer settings and update backend/.env.',
    );
    return;
  }
  if (secondsLeft < 3600) {
    logger.warn(
      { secondsLeft, expiresAt: new Date(exp * 1000).toISOString() },
      'FRESHBOOKS_API_TOKEN expires within the hour — refresh soon.',
    );
  }
}
