import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyWebhookSignature } from '../src/services/webhook.service';
import { env } from '../src/config/env';

// NOTE: full DB integration tests live in tests/integration/* and
// require a running Postgres. This file only covers pure helpers.

describe('verifyWebhookSignature', () => {
  // Use the same secret the service resolved at import time. Mutating
  // process.env here would be too late — env.ts caches on first load.
  const secret = env.FRESHBOOKS_WEBHOOK_SECRET;

  const body = Buffer.from(JSON.stringify({ event_id: 'evt_1', foo: 'bar' }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64');

  it('accepts a valid signature', () => {
    expect(verifyWebhookSignature(body, sig)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(verifyWebhookSignature(body, 'totallybogus')).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
  });
});
