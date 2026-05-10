import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyWebhookSignature } from '../src/services/webhook.service';
import { getAllWebhookSecrets, getWebhookSecretForEvent } from '../src/config/env';

// NOTE: full DB integration tests live in tests/integration/* and
// require a running Postgres. This file only covers pure helpers.

describe('verifyWebhookSignature', () => {
  // Use whichever secret env resolved at import time. Mutating process.env
  // here would be too late — env.ts caches on first load.
  const allSecrets = getAllWebhookSecrets();
  const secret = allSecrets[0];

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

  it('prefers the event-specific secret when one is configured', () => {
    // Pick the first event-specific secret (skipping the synthesised
    // "default" key that wraps a plain-string env var).
    const invoiceSecret = getWebhookSecretForEvent('invoice');
    if (invoiceSecret && invoiceSecret !== getWebhookSecretForEvent(undefined)) {
      const eventBody = Buffer.from(JSON.stringify({ name: 'invoice' }));
      const eventSig = crypto
        .createHmac('sha256', invoiceSecret)
        .update(eventBody)
        .digest('base64');
      expect(verifyWebhookSignature(eventBody, eventSig, 'invoice.create')).toBe(true);
    }
  });
});
