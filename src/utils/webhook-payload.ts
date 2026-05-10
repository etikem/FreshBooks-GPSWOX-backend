import crypto from 'crypto';

/**
 * FreshBooks webhook payload normaliser.
 *
 * FreshBooks delivers webhooks in TWO different shapes depending on the
 * endpoint and account configuration we observe in the wild:
 *
 *   1. Modern: application/json
 *      {"event_id":"...","name":"invoice.create","object":{"id":...}}
 *
 *   2. Legacy/forms: application/x-www-form-urlencoded
 *      name=invoice.create&object_id=12345&account_id=GoPRMM&verified=<verifier>&user_id=...
 *
 * Both must be parsed and then mapped onto the same shape that
 * `processWebhookEvent` expects: a flat record with `event_id`, `event_type`
 * (or `name`), and an `object` sub-record carrying the affected entity.
 *
 * The `verified` field on form-encoded events IS the FreshBooks signature.
 * It must equal the verifier we registered as FRESHBOOKS_WEBHOOK_SECRET.
 */
export interface ParsedWebhook {
  /** Canonical event id used for idempotency. */
  eventId: string;
  /** Lowercased event name, e.g. "invoice.create". */
  eventType: string;
  /** Flattened payload object the rest of the pipeline reads. */
  parsed: Record<string, unknown>;
  /** True when the body was form-urlencoded rather than JSON. */
  isFormEncoded: boolean;
  /** Verifier extracted from the body, if any (form-encoded only). */
  bodyVerifier: string | null;
  /** True when this looks like the registration verify handshake. */
  isVerifyHandshake: boolean;
}

/**
 * Best-effort parse. Never throws — on a body we can't make sense of, returns
 * a payload with isFormEncoded=false and parsed=null-ish so the caller can
 * 400 cleanly.
 */
export function parseWebhookBody(rawBody: Buffer, contentType?: string): ParsedWebhook | null {
  const text = rawBody.toString('utf8').trim();
  if (!text) return null;

  const ct = (contentType ?? '').toLowerCase();
  // FreshBooks doesn't always set a useful content-type. Use heuristics:
  //   - starts with `{` or `[` → JSON
  //   - contains `=` and `&` (or just `=`) and no `{` → form
  const looksJson = text.startsWith('{') || text.startsWith('[');
  const looksForm =
    !looksJson && (text.includes('=') || ct.includes('x-www-form-urlencoded'));

  if (looksJson || ct.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return finaliseParsed(parsed, /* isFormEncoded */ false);
    } catch {
      return null;
    }
  }

  if (looksForm) {
    const parsed: Record<string, unknown> = {};
    const sp = new URLSearchParams(text);
    for (const [k, v] of sp.entries()) {
      // Coerce numeric ids — most downstream code stringifies anyway,
      // but this keeps the shape consistent with the JSON variant.
      parsed[k] = v;
    }
    return finaliseParsed(parsed, /* isFormEncoded */ true);
  }

  return null;
}

function finaliseParsed(
  parsed: Record<string, unknown>,
  isFormEncoded: boolean,
): ParsedWebhook {
  const eventType = String(
    parsed.event_type ?? parsed.eventType ?? parsed.name ?? 'unknown',
  ).toLowerCase();

  // Verify handshake comes in two flavours:
  //   JSON:  {"name":"verify",  "verifier":"..."}
  //   form:  name=callback.verify&verifier=...
  const isVerifyHandshake =
    eventType === 'verify' ||
    eventType === 'callback.verify' ||
    parsed.verifier !== undefined && eventType === 'unknown';

  const bodyVerifier =
    typeof parsed.verified === 'string'
      ? parsed.verified
      : typeof parsed.verifier === 'string'
        ? parsed.verifier
        : null;

  // Build a normalised `object` sub-record. Form payloads have flat keys like
  // object_id / user_id; modern JSON nests them under `object`. The processor
  // already prefers the explicit object then falls back to top-level fields,
  // so we just need to ensure the object record exists when we have ids.
  //
  // IMPORTANT: form-encoded `user_id` is the FreshBooks STAFF user that
  // triggered the event, not the customer/client. We deliberately do NOT
  // copy it into the synthetic `object.userid` — for invoice/payment events
  // the customer id has to be resolved by a separate API call.
  if (!('object' in parsed) && parsed.object_id) {
    parsed.object = {
      id: parsed.object_id,
    };
  }

  // Stable event id: prefer explicit, else hash key fields, else hash full body.
  const eventId = deriveEventId(parsed, eventType);

  return {
    eventId,
    eventType,
    parsed,
    isFormEncoded,
    bodyVerifier,
    isVerifyHandshake,
  };
}

function deriveEventId(payload: Record<string, unknown>, eventType: string): string {
  // FreshBooks JSON webhooks expose a real event_id; trust it as-is.
  const explicit = payload.event_id ?? payload.eventId;
  if (explicit) return String(explicit);

  // Form-encoded webhooks have NO per-delivery identifier — FreshBooks sends
  // the same shape for every legitimate event of the same type+object. A
  // stable synthesised id (eventType:objectId) collapses every subsequent
  // update for that object onto the first row via the (source, eventId)
  // unique index, and processWebhookEvent silently skips it as "already
  // processed". To preserve real new events we append a per-delivery nonce.
  //
  // Trade-off: a true FreshBooks retry (only fires on non-2xx, and the
  // controller ACKs 200 immediately) gets processed twice. processWebhookEvent
  // -> evaluateAndApply re-fetches truth from FreshBooks on every run, so
  // duplicate processing is harmless — at worst a redundant SyncRun row.
  const objId =
    (payload.object as Record<string, unknown> | undefined)?.id ??
    payload.object_id ??
    payload.id;
  const nonce = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  if (objId) return `${eventType}:${objId}:${nonce}`;

  // Last resort — hash the body and tack the nonce on so pathological
  // payloads with no object_id are also unique per delivery.
  const seed = JSON.stringify({
    eventType,
    account_id: payload.account_id,
    user_id: payload.user_id,
    payload,
  });
  return `${eventType}:${crypto.createHash('sha256').update(seed).digest('hex')}:${nonce}`;
}

/**
 * Constant-time compare for short strings. Used for verifier checks.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
