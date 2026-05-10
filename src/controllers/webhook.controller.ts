import { Request, Response, NextFunction } from 'express';
import {
  ingestWebhook,
  processWebhookEvent,
  verifyWebhookHmac,
} from '../services/webhook.service';
import { parseWebhookBody, timingSafeEqualString } from '../utils/webhook-payload';
import { getWebhookSecretForEvent } from '../config/env';
import { logger } from '../utils/logger';
import { raw } from '@prisma/client/runtime/library';
import { get } from 'http';

/**
 * POST /webhooks/freshbooks
 *
 * Strategy:
 *   1. Parse the body (JSON or form-urlencoded).
 *   2. Authenticate one of two ways:
 *        a. The body carries `verified=<verifier>` (modern FreshBooks form
 *           webhooks) — compare against FRESHBOOKS_WEBHOOK_SECRET in
 *           constant-time.
 *        b. The request carries an `x-freshbooks-hmac-sha256` header —
 *           verify HMAC. Kept as a fallback for any header-signed variant.
 *   3. Persist the raw event (idempotent on (source, eventId)).
 *   4. Respond 200 immediately so FreshBooks doesn't retry.
 *   5. Process the event asynchronously. Failures land in the retry queue.
 */
export async function freshbooksWebhookHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Express raw-body middleware parks the buffer at req.body.
    const rawBody = req.body as Buffer;

    if (!Buffer.isBuffer(rawBody)) {
      res.status(400).json({ error: 'expected raw body' });
      return;
    }

    const contentType = req.header('content-type') ?? undefined;
    const parsed = parseWebhookBody(rawBody, contentType);

    if (!parsed) {
      logger.warn(
        { ip: req.ip, contentType, bodyLen: rawBody.length },
        'webhook.unparseable',
      );
      res.status(400).json({ error: 'unparseable body' });
      return;
    }

    // ── 1. Verify handshake (FreshBooks asks us to echo OK once at registration).
    if (parsed.isVerifyHandshake) {
      logger.warn(
        {
          rawBody: rawBody.toString('utf8'),
          headers: req.headers,
          parsed: parsed,
        },
        'webhook.verify-handshake — copy the verifier into FRESHBOOKS_WEBHOOK_SECRET if it differs',
      );
      res.status(200).json({ ok: true });
      return;
    }

    // ── 2. Authenticate.
    const headerSig =
      req.header('x-freshbooks-hmac-sha256') ??
      req.header('x-freshbooks-hmac') ??
      req.header('freshbooks-signature') ??
      undefined;
    // Per-event secret. FreshBooks issues a separate verifier for each
    // registered callback, so we look up the right one by event name and
    // fall back to a "default" key if the env var was configured as a
    // plain string. Missing entry → treat the request as unauthenticated.
    const eventType = parsed.eventType.toLowerCase().split('.')[0]; // e.g. "invoice.create" → "invoice"
    const expectedSecret = getWebhookSecretForEvent(eventType);

    let authenticated = false;

    // 2a. Body-verifier path (form webhooks). FreshBooks sends `verified=...`.
    if (parsed.bodyVerifier && expectedSecret) {
      authenticated = timingSafeEqualString(parsed.bodyVerifier, expectedSecret);
    }
    // 2b. HMAC header path (any future header-signed variant).
    if (!authenticated && headerSig) {
      authenticated = verifyWebhookHmac(rawBody, headerSig, parsed.eventType);
    }

    if (!authenticated) {
      logger.warn(
        {
          ip: req.ip,
          eventType: parsed.eventType,
          hadVerifier: !!parsed.bodyVerifier,
          hadHmacHeader: !!headerSig,
          hadSecretForEvent: !!expectedSecret,
        },
        'webhook.bad-signature',
      );
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    // ── 3. Idempotent persistence.
    const { duplicate, alreadyProcessed, webhookEventId } = await ingestWebhook({
      eventId: parsed.eventId,
      eventType: parsed.eventType,
      parsed: parsed.parsed,
      signature: headerSig ?? null,
    });

    // ── 4. ACK fast — FreshBooks marks any non-2xx as failure and retries.
    res.status(200).json({ ok: true, duplicate, alreadyProcessed });

    // Skip processing only when the prior delivery FULLY succeeded. A
    // duplicate that landed on an unprocessed/failed row gets reprocessed —
    // otherwise a transient earlier error (e.g. FreshBooks 5xx during the
    // OAuth refresh dance) would permanently strand the client/payment row.
    if (duplicate && alreadyProcessed) return;

    // ── 5. Fire-and-forget. Errors land in ActionLog/RetryJob inside
    // processWebhookEvent; if the process itself dies, the event row is still
    // PENDING and will be picked up by the catch-up sweep on next boot.
    setImmediate(() => {
      processWebhookEvent(webhookEventId).catch((err) =>
        logger.error(
          { err: (err as Error).message, webhookEventId },
          'webhook.process.failed',
        ),
      );
    });

    //-----------------------

  } catch (err) {
    next(err);
  }
}
