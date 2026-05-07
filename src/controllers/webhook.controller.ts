import { Request, Response, NextFunction } from 'express';
import {
  ingestWebhook,
  processWebhookEvent,
  verifyWebhookSignature,
} from '../services/webhook.service';
import { logger } from '../utils/logger';

/**
 * POST /webhooks/freshbooks
 *
 * Strategy:
 *   1. Verify HMAC.
 *   2. Persist the raw event (idempotent on (source, eventId)).
 *   3. Respond 200 immediately so FreshBooks doesn't retry.
 *   4. Process the event asynchronously. Failures land in the retry queue.
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

    const sig =
      req.header('x-freshbooks-hmac-sha256') ??
      req.header('x-freshbooks-hmac') ??
      req.header('freshbooks-signature') ??
      undefined;

    // FreshBooks verification handshake. The verify POST is unsigned
    // (no shared secret yet) and carries the verifier in the body. Log it
    // loudly so we can copy it into FRESHBOOKS_WEBHOOK_SECRET.
    const bodyText = rawBody.toString('utf8');
    if (bodyText.includes('callback.verify') || bodyText.includes('"name":"verify"')) {
      logger.warn(
        { rawBody: bodyText, headers: req.headers },
        'webhook.verify-handshake — copy the verifier into FRESHBOOKS_WEBHOOK_SECRET',
      );
      res.status(200).json({ ok: true });
      return;
    }

    if (!verifyWebhookSignature(rawBody, sig)) {
      logger.warn({ ip: req.ip }, 'webhook.bad-signature');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid json' });
      return;
    }

    const { duplicate, webhookEventId } = await ingestWebhook({
      rawBody,
      signature: sig,
      parsed,
    });

    // ACK fast — FreshBooks marks any non-2xx as a failure and retries.
    res.status(200).json({ ok: true, duplicate });

    if (duplicate) return;

    // Fire-and-forget. Errors are captured into ActionLog/RetryJob inside
    // processWebhookEvent; if the process itself dies mid-flight, the
    // event row is still PENDING and will be picked up by the catch-up
    // sweep on next boot.
    setImmediate(() => {
      processWebhookEvent(webhookEventId).catch((err) =>
        logger.error(
          { err: (err as Error).message, webhookEventId },
          'webhook.process.failed',
        ),
      );
    });
  } catch (err) {
    next(err);
  }
}