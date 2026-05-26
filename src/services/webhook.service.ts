import crypto from 'crypto';
import * as querystring from 'querystring';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { env, getAllWebhookSecrets, getWebhookSecretForEvent } from '../config/env';
import { freshbooksService } from './freshbooks.service';
import { abctrackService } from './abctrack.service';
import { clientMappingService } from './client-mapping.service';
import { decideAccess } from './balance.engine';
import { enqueueRetry } from './retry.service';
import { TransientHttpError } from '../utils/http';
import { toMoney } from '../utils/decimal';
import { nextMonthTenthAtEightUtc } from '../utils/expiration';

/**
 * Recompute Client.lastPaymentAt from the PaymentLog table. Called after
 * any write to PaymentLog (insert on payment.create, delete on
 * payment.delete). MAX(paidAt) is the authoritative value — denormalised
 * onto the Client row so the decision engine and cron sweep don't need a
 * subquery for every read.
 */
async function refreshLastPaymentAt(clientId: string): Promise<void> {
  const latest = await prisma.paymentLog.findFirst({
    where: { clientId, paidAt: { not: null } },
    orderBy: { paidAt: 'desc' },
    select: { paidAt: true },
  });
  await prisma.client.update({
    where: { id: clientId },
    data: { lastPaymentAt: latest?.paidAt ?? null },
  });
}

/**
 * Verify the HMAC signature of a FreshBooks webhook. The header name varies
 * by API version; the controller already tries the common spellings before
 * calling us. Used as a fallback path — the modern form-encoded webhooks
 * are authenticated via the `verified` body field, not a header.
 *
 * `eventType` is optional because callers in the verify-handshake path
 * don't know it yet. When provided we try that event's secret first; if it
 * doesn't match (or wasn't configured) we fall through to every other
 * configured secret. This lets us roll over a per-event verifier without
 * dropping in-flight events from a sibling event type.
 */
function toFreshBooksJson(
  payload: Record<string, any>,
): string {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(payload)) {
    normalized[key] = String(value);
  }

  // Python-style JSON spacing
  return JSON.stringify(normalized)
    .replace(/:/g, ': ')
    .replace(/,/g, ', ');
}

export function verifyWebhookHmac(
  rawBody: Buffer,
  header: string | undefined,
  eventType?: string,
): boolean {
  try {
    if (!header) {
      console.log('Missing HMAC header');
      return false;
    }

    const candidates: string[] = [];

    const primary = getWebhookSecretForEvent(eventType);

    if (primary) {
      candidates.push(primary);
    }

    for (const s of getAllWebhookSecrets()) {
      if (!candidates.includes(s)) {
        candidates.push(s);
      }
    }

    // Parse x-www-form-urlencoded body
    const parsed = querystring.parse(
      rawBody.toString('utf8'),
    );

    // FreshBooks signs JSON version
    const payload = toFreshBooksJson(parsed);

    console.log('FreshBooks payload:', payload);

    const headerBuf = Buffer.from(header, 'utf8');

    for (const secret of candidates) {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(payload, 'utf8')
        .digest('base64');

      const expectedBuf = Buffer.from(expected, 'utf8');

      const matched =
        expectedBuf.length === headerBuf.length &&
        crypto.timingSafeEqual(
          expectedBuf,
          headerBuf,
        );

      console.log({
        secret,
        expected,
        received: header,
        matched,
      });

      if (matched) {
        return true;
      }
    }

    return false;
  } catch (err) {
    console.error(
      'Webhook verification failed:',
      err,
    );

    return false;
  }
}

// Keep the old name as an alias so existing tests (and any external callers)
// keep working without modification.
export const verifyWebhookSignature = verifyWebhookHmac;

export interface IncomingWebhook {
  eventId: string;
  eventType: string;
  parsed: Record<string, unknown>;
  signature: string | null;
}

/**
 * Persist + dedupe.
 *
 * Idempotency: we rely on the (source, eventId) unique index on
 * WebhookEvent. If two requests arrive for the same event, the second
 * insert throws and we treat the event as already-handled.
 *
 * tenantId: best-effort populated from FRESHBOOKS_ACCOUNT_ID so that
 * multi-tenant queries work. The tenant row is created lazily on first
 * write of either an event or a client.
 */
export async function ingestWebhook(input: IncomingWebhook): Promise<{
  duplicate: boolean;
  /**
   * True only when the existing row was already fully processed AND not
   * marked failed. Re-deliveries that landed on an unprocessed or failed
   * row should re-enter processWebhookEvent rather than silently skip — a
   * transient failure on the first attempt must not strand the update.
   */
  alreadyProcessed: boolean;
  webhookEventId: string;
}> {
  const tenantId = await ensureTenantId();

  try {
    const created = await prisma.webhookEvent.create({
      data: {
        tenantId,
        source: 'freshbooks',
        eventId: input.eventId,
        eventType: input.eventType,
        rawPayload: input.parsed as Prisma.InputJsonValue,
        signature: input.signature,
      },
    });
    console.log('Webhook ingested with id', created);
    return { duplicate: false, alreadyProcessed: false, webhookEventId: created.id };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const existing = await prisma.webhookEvent.findUnique({
        where: { source_eventId: { source: 'freshbooks', eventId: input.eventId } },
      });
      const alreadyProcessed = !!existing?.processed && !existing?.failed;
      logger.info(
        { eventId: input.eventId, alreadyProcessed, failed: existing?.failed },
        'webhook.duplicate',
      );
      // If we land on a stale unprocessed/failed row, clear the failure
      // flags so the re-entry path produces a clean audit trail.
      if (existing && !alreadyProcessed) {
        await prisma.webhookEvent.update({
          where: { id: existing.id },
          data: { failed: false, failureReason: null },
        });
      }
      return { duplicate: true, alreadyProcessed, webhookEventId: existing!.id };
    }
    throw err;
  }
}

async function ensureTenantId(): Promise<string> {
  const existing = await prisma.tenant.findFirst({
    where: { freshbooksAccountId: env.FRESHBOOKS_ACCOUNT_ID },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await prisma.tenant.create({
    data: {
      name: `FreshBooks ${env.FRESHBOOKS_ACCOUNT_ID}`,
      freshbooksAccountId: env.FRESHBOOKS_ACCOUNT_ID,
    },
    select: { id: true },
  });
  logger.info({ tenantId: created.id }, 'tenant.bootstrapped');
  return created.id;
}

/**
 * Process an event end-to-end. The webhook controller calls this AFTER
 * acknowledging the HTTP request (so a slow ABC Track call never causes
 * FreshBooks to retry). Errors here are captured into ActionLog or the
 * retry queue rather than thrown to the HTTP layer.
 */
export async function processWebhookEvent(webhookEventId: string): Promise<void> {
  const ev = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
  });
  if (!ev || ev.processed) return;

  try {
    const payload = ev.rawPayload as Record<string, unknown>;
    const obj = (payload.object as Record<string, unknown> | undefined) ?? payload;
    const eventType = ev.eventType.toLowerCase();
    const isClientEvent = /(^|\.)(client|user)(\.|$)/.test(eventType);
    const isInvoiceEvent = /(^|\.)invoice(\.|$)/.test(eventType);
    const isPaymentEvent = /(^|\.)payment(\.|$)/.test(eventType);
    const isDelete = /(delete|destroy)/.test(eventType);

    // Resolve the FreshBooks customer id by event type. Form-encoded
    // webhooks only carry `object_id` (the entity id) and a staff
    // `user_id` — the actual customer is not in the payload at all for
    // invoice/payment events, so we look it up via the FreshBooks API.
    // Modern JSON webhooks include the customer id on the `object`
    // sub-record and skip the API call.
    let freshbooksClientId: string | undefined;
    let fetchedPayment: Record<string, unknown> | null = null;

    if (isClientEvent) {
      // Client events: `object_id` IS the customer id.
      freshbooksClientId = (
        (obj.id as string | number | undefined) ??
        (obj.userid as string | number | undefined) ??
        (obj.user_id as string | number | undefined)
      )?.toString();
    } else if (isInvoiceEvent) {
      freshbooksClientId =
        (obj.customerid as string | number | undefined)?.toString() ??
        (obj.userid as string | undefined) ??
        (obj.client_id as string | undefined) ??
        (obj.clientid as string | undefined);
      if (!freshbooksClientId) {
        const invoiceId =
          (payload.object_id as string | undefined) ??
          ((obj.id as string | number | undefined)?.toString());
        if (invoiceId) {
          freshbooksClientId =
            (await freshbooksService.getInvoiceCustomerId(invoiceId)) ?? undefined;
        }
      }
    } else if (isPaymentEvent) {
      freshbooksClientId =
        (obj.clientid as string | number | undefined)?.toString() ??
        (obj.client_id as string | undefined) ??
        (obj.userid as string | undefined);
      if (!freshbooksClientId) {
        const paymentId =
          (payload.object_id as string | undefined) ??
          ((obj.id as string | number | undefined)?.toString());
        if (paymentId) {
          fetchedPayment = await freshbooksService.getPayment(paymentId);
          freshbooksClientId = (
            (fetchedPayment?.clientid as string | number | undefined) ??
            (fetchedPayment?.client_id as string | number | undefined) ??
            (fetchedPayment?.userid as string | number | undefined)
          )?.toString();
        }
      }
    }

    const email =
      (obj.email as string | undefined) ?? (payload.email as string | undefined);

    console.log('email:', email);
    let client = await clientMappingService.identifyFromPayload({
      freshbooksClientId,
      email,
    });

    // ── client.delete: hard-delete the ABC Track user, then mark CANCELLED.
    // We try one last email lookup if the row was never auto-mapped so the
    // GPS account doesn't outlive the FreshBooks client. Failures are
    // recorded but never block the local CANCELLED transition.
    if (isClientEvent && isDelete) {
      if (client) {
        let gpswoxUserId = client.gpswoxUserId;
        let resolvedViaEmail = false;
        if (!gpswoxUserId && client.email) {
          try {
            const hit = await abctrackService.findUserByEmail(client.email);
            if (hit) {
              gpswoxUserId = String(hit.id);
              resolvedViaEmail = true;
              await prisma.client.update({
                where: { id: client.id },
                data: { gpswoxUserId },
              });
              await prisma.actionLog.create({
                data: {
                  clientId: client.id,
                  kind: 'GPSWOX_MATCHED',
                  message:
                    'Resolved ABC Track user via email on client-delete event.',
                  details: { gpswoxUserId, email: client.email },
                },
              });
            }
          } catch (err) {
            await prisma.actionLog.create({
              data: {
                clientId: client.id,
                kind: 'ERROR',
                message: `abctrack.findByEmail on client-delete failed: ${(err as Error).message}`,
                details: { eventId: ev.eventId, email: client.email },
              },
            });
          }
        }

        let blocked = false;
        if (gpswoxUserId && client.status !== 'CANCELLED') {
          try {
            await abctrackService.deactivate({
              clientId: client.id,
              gpswoxUserId,
              email: client.email,
            });
            blocked = true;
          } catch (err) {
            await prisma.actionLog.create({
              data: {
                clientId: client.id,
                kind: 'ERROR',
                message: `abctrack.disable on client-delete failed: ${(err as Error).message}`,
                details: { eventId: ev.eventId },
              },
            });
          }
        }
        await prisma.client.update({
          where: { id: client.id },
          data: {
            status: 'CANCELLED',
            lastSyncedAt: new Date(),
          },
        });
        await prisma.actionLog.create({
          data: {
            clientId: client.id,
            kind: 'DECISION_BLOCK',
            message: gpswoxUserId
              ? resolvedViaEmail
                ? 'Client deleted in FreshBooks — resolved ABC Track user via email, expired access, marked CANCELLED.'
                : 'Client deleted in FreshBooks — ABC Track access expired, marked CANCELLED.'
              : 'Client deleted in FreshBooks — marked CANCELLED (no ABC Track user found by email).',
            details: { eventId: ev.eventId, gpswoxUserId, blocked },
          },
        });
      }
      await markProcessed(ev.id);
      return;
    }

    // For every non-delete event (client.create/update, invoice.*, payment.*)
    // refresh the client from FreshBooks (truth) before acting. Identify+
    // upsert may already have done this when freshbooksClientId was present;
    // doing it again is the cheapest way to guarantee we have current data
    // for invoice events that started from an email-only match.
    if (freshbooksClientId) {
      client = await ensureClientFromFreshbooks(freshbooksClientId);
    } else if (client) {
      client = await ensureClientFromFreshbooks(client.freshbooksClientId);
    }

    // Email-driven auto-mapping of the ABC Track user. Idempotent — if the
    // mapping is already set we skip; otherwise we set it from the email
    // lookup, or log an ERROR action when no ABC Track user matches.
    let autoCreated = false;
    if (client && !client.gpswoxUserId) {
      const result = await tryAutoMapGpswoxUser(client);
      client = result.client;
      autoCreated = result.autoCreated;
    }

    if (!client) {
      await prisma.webhookEvent.update({
        where: { id: ev.id },
        data: {
          processed: true,
          processedAt: new Date(),
          failed: true,
          failureReason: 'unknown client',
        },
      });
      await prisma.actionLog.create({
        data: {
          kind: 'ERROR',
          message: 'Webhook for unknown client — ignored.',
          details: { freshbooksClientId, email, eventId: ev.eventId },
        },
      });
      logger.warn(
        { freshbooksClientId, email, eventId: ev.eventId },
        'webhook.unknown-client',
      );
      return;
    }

    // Profile sync to ABC Track has been intentionally removed. Per the
    // operating rules, ABC Track is only written in three cases:
    //   1. client.create — full profile + initial state via createUser
    //      (handled by tryAutoMapGpswoxUser above).
    //   2. payment.* — expiration date only (via evaluateAndApply below).
    //   3. client.delete — active=0 (handled above before this point).
    // No other event may push fields to ABC Track.

    // Record the payment event before we re-evaluate. Form-encoded
    // payment webhooks don't carry amount/date/etc., so prefer the payment
    // record we fetched above when present.
    //
    // payment.delete / refund: drop the matching PaymentLog row so the
    // decision engine sees the reversal. If this was the latest payment,
    // `lastPaymentAt` falls back to the next-newest row (or null).
    if (isPaymentEvent && !isDelete) {
      const paymentObj = fetchedPayment ?? obj;
      await recordPaymentLog(client.id, payload, paymentObj).catch((e) =>
        logger.warn({ err: e?.message }, 'payment-log.write.failed'),
      );
    } else if (isPaymentEvent && isDelete) {
      const paymentObj = fetchedPayment ?? obj;
      await deletePaymentLog(client.id, payload, paymentObj).catch((e) =>
        logger.warn({ err: e?.message }, 'payment-log.delete.failed'),
      );
    }

    // Decision branching — the only event that touches ABC Track here
    // is payment.*, which calls evaluateAndApply to update the expiration
    // date. Everything else is local-only.
    if (isPaymentEvent) {
      await evaluateAndApply({
        clientId: client.id,
        trigger: 'WEBHOOK',
        webhookEventId: ev.id,
      });
    } else if (isInvoiceEvent) {
      // Invoice events: refresh the local cache for the dashboard. No
      // ABC Track call. The monthly recurring-invoice create FreshBooks
      // fires on the 25th must never touch access state.
      try {
        const invoices = await freshbooksService.listInvoicesForClient(
          client.freshbooksClientId,
        );
        await refreshInvoiceCache(client.id, invoices);
      } catch (e) {
        logger.warn(
          { err: (e as Error).message, clientId: client.id },
          'invoice-cache.refresh.failed',
        );
      }
    } else if (autoCreated) {
      // Newly auto-created ABC Track user (from a client.create) already
      // has the full profile + initial expiration set by createUser. Just
      // log the decision; do not re-evaluate.
      await prisma.actionLog.create({
        data: {
          clientId: client.id,
          kind: 'DECISION_RESTORE',
          message: `New client — access granted until ${nextMonthTenthAtEightUtc(new Date()).toISOString().slice(0, 10)}.`,
          details: { effectiveAccessExpiresAt: client.accessExpiresAt?.toISOString() ?? null },
        },
      });
    }
    // client.update / client.create for already-mapped clients / any other
    // event type: no-op. No ABC Track write, no access re-evaluation.

    await markProcessed(ev.id);
  } catch (err) {
    const message = (err as Error).message;
    // Persist the failure on the webhook row so the Logs page surfaces it.
    await prisma.webhookEvent
      .update({
        where: { id: ev.id },
        data: {
          failed: true,
          failureReason: message.slice(0, 500),
        },
      })
      .catch(() => undefined);
    throw err;
  }
}

async function markProcessed(webhookEventId: string): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id: webhookEventId },
    data: { processed: true, processedAt: new Date() },
  });
}

/**
 * Insert a PaymentLog row for observability. Picks values out of the
 * payload defensively — payment webhook shapes vary widely.
 */
async function recordPaymentLog(
  clientId: string,
  payload: Record<string, unknown>,
  obj: Record<string, unknown>,
): Promise<void> {
  const amountRaw =
    (obj.amount as unknown) ??
    (payload.amount as unknown) ??
    (typeof obj.amount === 'object' && obj.amount && 'amount' in (obj.amount as object)
      ? (obj.amount as { amount?: unknown }).amount
      : undefined);
  const amount = toMoney(amountRaw) ?? toMoney(0)!;
  const currency =
    ((obj.currency_code ?? obj.currency) as string | undefined) ??
    ((payload.currency_code ?? payload.currency) as string | undefined) ??
    'USD';
  const paidAtRaw =
    (obj.date as string | undefined) ??
    (obj.paid_date as string | undefined) ??
    (payload.date as string | undefined);
  const paidAt = paidAtRaw ? new Date(paidAtRaw) : null;
  const freshbooksPaymentId =
    (obj.id as string | number | undefined)?.toString() ??
    (payload.object_id as string | undefined) ??
    null;
  const invoiceId =
    (obj.invoiceid as string | number | undefined)?.toString() ??
    (obj.invoice_id as string | undefined) ??
    null;

  await prisma.paymentLog.create({
    data: {
      clientId,
      freshbooksPaymentId,
      invoiceId,
      amount: amount.toFixed(2),
      currency,
      paidAt: paidAt && !isNaN(paidAt.getTime()) ? paidAt : null,
      source: 'webhook',
      rawPayload: payload as Prisma.InputJsonValue,
    },
  });

  // Keep the denormalised `lastPaymentAt` on Client in sync. The decision
  // engine reads it directly.
  await refreshLastPaymentAt(clientId);
}

/**
 * Handle a payment.delete / refund webhook by dropping the matching
 * PaymentLog row(s). The access decision is rerun by the caller; if this
 * was the latest payment, `lastPaymentAt` falls back to the next-newest
 * row (or null if no payments remain).
 */
async function deletePaymentLog(
  clientId: string,
  payload: Record<string, unknown>,
  obj: Record<string, unknown>,
): Promise<void> {
  const freshbooksPaymentId =
    (obj.id as string | number | undefined)?.toString() ??
    (payload.object_id as string | undefined) ??
    null;
  if (!freshbooksPaymentId) {
    logger.warn({ clientId }, 'payment-log.delete.no-id');
    return;
  }
  await prisma.paymentLog.deleteMany({
    where: { clientId, freshbooksPaymentId },
  });
  await refreshLastPaymentAt(clientId);
}

/**
 * Email-driven auto-mapping. Critical integration rule: USER EMAIL is
 * the primary key between FreshBooks and ABC Track, since ABC Track has
 * no native search and IDs aren't shared between systems.
 *
 * Behaviour:
 *   - If the client already has gpswoxUserId, return as-is. We never
 *     overwrite an existing mapping — that's an operator responsibility.
 *   - If an ABC Track user with the same email is found, save the id and
 *     log a GPSWOX_MATCHED action. (The action-kind enum still uses the
 *     GPSWOX_ prefix for historical-data compatibility — see
 *     abctrack.service.ts for the rationale.)
 *   - If no ABC Track user matches, auto-create one in ABC Track so
 *     FreshBooks and ABC Track stay in sync. The new user starts active=1
 *     with the FreshBooks contract end date as expiration; evaluateAndApply
 *     will flip them to disabled immediately if they have unpaid invoices.
 *     Skipped only when the FreshBooks profile had no real email and we
 *     saved a placeholder.
 *
 * Never throws — failures degrade to a logged warning. The downstream
 * decision pipeline already handles "no gpswoxUserId" cleanly.
 */
type AutoMapResult = {
  client: NonNullable<Awaited<ReturnType<typeof clientMappingService.findByFreshbooksClientId>>>;
  autoCreated: boolean;
};

async function tryAutoMapGpswoxUser(
  client: NonNullable<Awaited<ReturnType<typeof clientMappingService.findByFreshbooksClientId>>>,
): Promise<AutoMapResult> {
  if (client.gpswoxUserId) return { client, autoCreated: false };
  if (!client.email) return { client, autoCreated: false };
  // Don't flip CANCELLED clients — their lifecycle is over.
  if (client.status === 'CANCELLED') return { client, autoCreated: false };

  try {
    const hit = await abctrackService.findUserByEmail(client.email);
    if (hit) {
      const updated = await prisma.client.update({
        where: { id: client.id },
        data: {
          gpswoxUserId: String(hit.id),
          // If the prior status was the missing-mapping flag, clear it.
          // The next evaluateAndApply will land on the correct status.
          ...(client.status === 'NO_MATCHING_GPSWOX_USER'
            ? { status: 'UNKNOWN' }
            : {}),
          lastSyncedAt: new Date(),
        },
      });
      await prisma.actionLog.create({
        data: {
          clientId: client.id,
          kind: 'GPSWOX_MATCHED',
          message: `Auto-matched ABC Track user id=${hit.id} via email.`,
          details: { gpswoxUserId: hit.id, email: client.email },
        },
      });
      return { client: updated, autoCreated: false };
    }

    // We skip auto-create when the FreshBooks profile lacked an email and we
    // saved the placeholder — pushing `freshbooks-<id>@no-email.local` onto
    // ABC Track would just create garbage rows.
    if (client.email.endsWith('@no-email.local')) {
      await prisma.actionLog.create({
        data: {
          clientId: client.id,
          kind: 'ERROR',
          message:
            'Cannot auto-create ABC Track user — FreshBooks profile has no real email.',
          details: { email: client.email },
        },
      });
      return { client, autoCreated: false };
    }

    const phoneNumber =
      client.mobilePhone ?? client.businessPhone ?? client.homePhone ?? null;
    const addressLine = [
      client.addressStreet,
      client.addressStreet2,
      [client.addressCity, client.addressProvince, client.addressCode]
        .filter(Boolean)
        .join(', '),
      client.addressCountry,
    ]
      .filter((v) => typeof v === 'string' && v.length > 0)
      .join('\n');

    const expiration = nextMonthTenthAtEightUtc(new Date());
    const newGpswoxUserId = await abctrackService.createUser({
      clientId: client.id,
      email: client.email,
      phoneNumber,
      firstName: client.firstName,
      lastName: client.lastName,
      address: addressLine || null,
      personalCode: client.freshbooksClientId,
      accessExpiresAt: expiration,
    });

    const updated = await prisma.client.update({
      where: { id: client.id },
      data: {
        gpswoxUserId: String(newGpswoxUserId),
        status: 'ACTIVE',
        accessExpiresAt: expiration,
        lastSyncedAt: new Date(),
      },
    });
    await prisma.actionLog.create({
      data: {
        clientId: client.id,
        kind: 'GPSWOX_MATCHED',
        message: `Auto-created ABC Track user id=${newGpswoxUserId} from FreshBooks profile.`,
        details: { gpswoxUserId: newGpswoxUserId, email: client.email },
      },
    });
    return { client: updated, autoCreated: true };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, clientId: client.id },
      'abctrack.auto-match.failed',
    );
  }
  return { client, autoCreated: false };
}

/**
 * Fetch a client from FreshBooks and upsert into our DB. Used by the
 * webhook handler so client.create / .update events propagate, and so
 * invoice events for clients we don't yet have don't get dropped.
 */
export async function ensureClientFromFreshbooks(
  freshbooksClientId: string,
): Promise<Awaited<ReturnType<typeof clientMappingService.findByFreshbooksClientId>>> {
  const tenantId = await ensureTenantId();
  const raw = await freshbooksService.getClient(freshbooksClientId);
  if (!raw) {
    // 404 from /users/clients/<id> — the client was deleted between the
    // webhook firing and our fetch, OR the id is for a different account.
    // Either way, surface it loudly: silently returning null was the
    // mode that hid earlier "client never appears in DB" bugs.
    logger.warn(
      { freshbooksClientId, tenantId },
      'freshbooks.client.fetch-empty',
    );
    return null;
  }

  // Email is the primary key between FreshBooks and ABC Track. If it's
  // missing we still want the row in the DB (the user explicitly asked
  // for "client created in FreshBooks → row in our DB"), so we save with
  // a stable sentinel and surface the gap on the operator dashboard.
  const rawEmail = (raw.email as string | undefined)?.trim().toLowerCase();
  const email = rawEmail && rawEmail.length > 0
    ? rawEmail
    : `freshbooks-${freshbooksClientId}@no-email.local`;
  const emailMissing = email !== rawEmail;

  const profile = extractClientProfile(raw);

  const signupRaw = raw.signup_date as string | undefined;
  const signup = signupRaw ? new Date(signupRaw) : new Date();
  const safeSignup = isNaN(signup.getTime()) ? new Date() : signup;
  const contractEnd = new Date(safeSignup);
  contractEnd.setFullYear(contractEnd.getFullYear() + 1);

  const saved = await prisma.client.upsert({
    where: {
      tenantId_freshbooksClientId: {
        tenantId,
        freshbooksClientId,
      },
    },
    // On update: refresh email and every profile field. We deliberately
    // overwrite on each client.* webhook so the local row never lags
    // behind the FreshBooks UI.
    update: { email, ...profile },
    create: {
      tenantId,
      email,
      ...profile,
      freshbooksClientId,
      contractStartDate: safeSignup,
      contractEndDate: contractEnd,
    },
  });

  logger.info(
    {
      clientId: saved.id,
      freshbooksClientId,
      email: saved.email,
      emailMissing,
    },
    'client.upserted-from-freshbooks',
  );

  if (emailMissing) {
    await prisma.actionLog.create({
      data: {
        clientId: saved.id,
        kind: 'ERROR',
        message:
          'FreshBooks profile has no email — saved with placeholder. ' +
          'Update the email in FreshBooks (or via PATCH /clients/<id>) ' +
          'to enable ABC Track auto-mapping.',
        details: { freshbooksClientId, placeholderEmail: email },
      },
    });
  }

  return saved;
}

/**
 * Pluck the profile fields from the FreshBooks `/users/clients/<id>` response.
 * Every field is optional — FreshBooks omits unset values entirely on some
 * accounts and returns empty strings on others, so we trim+null-empty here.
 */
function extractClientProfile(raw: Record<string, unknown>): {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  organization: string | null;
  businessPhone: string | null;
  mobilePhone: string | null;
  homePhone: string | null;
  addressStreet: string | null;
  addressStreet2: string | null;
  addressCity: string | null;
  addressProvince: string | null;
  addressCountry: string | null;
  addressCode: string | null;
  currencyCode: string | null;
  language: string | null;
  vatName: string | null;
  vatNumber: string | null;
  notes: string | null;
} {
  const firstName = nullEmpty(raw.fname);
  const lastName = nullEmpty(raw.lname);
  const organization = nullEmpty(raw.organization);
  const human = [firstName, lastName].filter(Boolean).join(' ').trim();
  const name = organization || (human || null);

  return {
    name,
    firstName,
    lastName,
    organization,
    businessPhone: nullEmpty(raw.bus_phone),
    mobilePhone: nullEmpty(raw.mob_phone),
    homePhone: nullEmpty(raw.home_phone),
    addressStreet: nullEmpty(raw.p_street),
    addressStreet2: nullEmpty(raw.p_street2),
    addressCity: nullEmpty(raw.p_city),
    addressProvince: nullEmpty(raw.p_province),
    addressCountry: nullEmpty(raw.p_country),
    addressCode: nullEmpty(raw.p_code),
    currencyCode: nullEmpty(raw.currency_code),
    language: nullEmpty(raw.language),
    vatName: nullEmpty(raw.vat_name),
    vatNumber: nullEmpty(raw.vat_number),
    // FreshBooks names the field `note` (singular) in the
    // /users/clients/<id> response. We persist it under the `notes` column.
    notes: nullEmpty(raw.note ?? raw.notes),
  };
}

function nullEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Single decision pipeline used by the webhook handler, the manual sync
 * admin endpoint, and the cron sweep. Always:
 *
 *   1. Read the client's lastPaymentAt (denormalised from PaymentLog).
 *   2. Refresh the invoice cache from FreshBooks for the dashboard
 *      (best-effort — invoices no longer drive access).
 *   3. Run the payment-driven access engine.
 *   4. Apply the decision to ABC Track.
 *   5. Update the Client row + persist a SyncRun record.
 *
 * Unlimited clients short-circuit: they're held ACTIVE with no ABC Track
 * expiration regardless of payment state.
 */
export async function evaluateAndApply(args: {
  clientId: string;
  trigger: 'WEBHOOK' | 'MANUAL' | 'CRON' | 'RETRY';
  webhookEventId?: string;
}): Promise<void> {
  const client = await prisma.client.findUniqueOrThrow({
    where: { id: args.clientId },
  });

  const run = await prisma.syncRun.create({
    data: {
      tenantId: client.tenantId,
      clientId: client.id,
      trigger: args.trigger,
    },
  });

  if (args.webhookEventId) {
    await prisma.webhookEvent.update({
      where: { id: args.webhookEventId },
      data: { syncRunId: run.id },
    });
  }

  try {
    // Best-effort refresh of the invoice cache for the dashboard. The
    // access decision no longer consults it. Skipped on FreshBooks
    // failure — we don't want a flaky FreshBooks to wedge access state
    // for unlimited or already-paid clients.
    try {
      const invoices = await freshbooksService.listInvoicesForClient(
        client.freshbooksClientId,
      );
      await refreshInvoiceCache(client.id, invoices);
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, clientId: client.id },
        'invoice-cache.refresh.failed',
      );
    }

    const decision = decideAccess({
      isUnlimited: client.isUnlimited,
      latestPaymentAt: client.lastPaymentAt,
      now: new Date(),
    });

    await prisma.actionLog.create({
      data: {
        clientId: client.id,
        kind: decision.shouldRestore ? 'DECISION_RESTORE' : 'DECISION_BLOCK',
        message: decision.reason,
        details: {
          isUnlimited: decision.isUnlimited,
          latestPaymentAt: decision.latestPaymentAt?.toISOString() ?? null,
          effectiveAccessExpiresAt:
            decision.effectiveAccessExpiresAt?.toISOString() ?? null,
        },
      },
    });

    if (decision.shouldRestore) {
      if (!client.gpswoxUserId) {
        // No ABC Track user matches this client's email. The operator needs
        // to create a matching user in ABC Track; the next sync will link it.
        const note =
          "Decision was RESTORE, but no ABC Track user has this client's email. Create a user in ABC Track with this email so the next sync can enable access.";
        await prisma.client.update({
          where: { id: client.id },
          data: {
            // Don't flip ACTIVE prematurely — keep prior status until mapped.
            lastSyncedAt: new Date(),
          },
        });
        await prisma.syncRun.update({
          where: { id: run.id },
          data: {
            outcome: 'NO_CHANGE',
            finishedAt: new Date(),
            notes: note,
          },
        });
        logger.warn({ clientId: client.id }, 'evaluate.restore-blocked-no-mapping');
        return;
      }
      await applyEnable({
        clientId: client.id,
        gpswoxUserId: client.gpswoxUserId,
        accessExpiresAt: decision.effectiveAccessExpiresAt,
        email: client.email,
      });
      await prisma.client.update({
        where: { id: client.id },
        data: {
          status: 'ACTIVE',
          accessExpiresAt: decision.effectiveAccessExpiresAt,
          lastSyncedAt: new Date(),
        },
      });
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          outcome: 'RESTORED',
          finishedAt: new Date(),
          notes: decision.reason,
        },
      });
    } else {
      // BLOCK path — local-only. ABC Track is never auto-disabled by the
      // billing pipeline. Per the operating rules, ABC Track expiration
      // is written once when a payment arrives; when that date passes,
      // ABC Track expires the user on its own without our involvement.
      // The only ABC Track deactivation is from client.delete, handled
      // separately above.
      await prisma.client.update({
        where: { id: client.id },
        data: {
          status: 'BLOCKED',
          accessExpiresAt: null,
          lastSyncedAt: new Date(),
        },
      });
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          outcome: 'BLOCKED',
          finishedAt: new Date(),
          notes: decision.reason,
        },
      });
    }
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ err: message, clientId: client.id }, 'evaluate.failed');
    await prisma.actionLog.create({
      data: {
        clientId: client.id,
        kind: 'ERROR',
        message: `evaluateAndApply failed: ${message}`,
      },
    });
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        outcome: 'ERROR',
        notes: message,
        finishedAt: new Date(),
      },
    });
    if (err instanceof TransientHttpError) {
      throw err;
    }
  }
}

async function applyEnable(args: {
  clientId: string;
  gpswoxUserId: string;
  // null → unlimited (enable_expiration_date=0 in ABC Track).
  accessExpiresAt: Date | null;
  /** DB-side email, required by Abctrack's update validator. See `abctrackService.enable`. */
  email: string | null;
}): Promise<void> {
  try {
    await abctrackService.enable(args);
  } catch (err) {
    if (err instanceof TransientHttpError) {
      const expirationLabel = args.accessExpiresAt?.toISOString() ?? 'unlimited';
      await enqueueRetry({
        clientId: args.clientId,
        operation: 'gpswox.enable',
        payload: {
          gpswoxUserId: args.gpswoxUserId,
          accessExpiresAt: args.accessExpiresAt?.toISOString() ?? null,
          email: args.email,
        },
        idempotencyKey: `enable:${args.clientId}:${expirationLabel}`,
        initialError: err.message,
      });
      return;
    }
    throw err;
  }
}

async function refreshInvoiceCache(
  clientId: string,
  invoices: Awaited<ReturnType<typeof freshbooksService.listInvoicesForClient>>,
): Promise<void> {
  for (const inv of invoices) {
    await prisma.invoiceCache.upsert({
      where: {
        clientId_freshbooksInvoiceId: {
          clientId,
          freshbooksInvoiceId: inv.id,
        },
      },
      create: {
        clientId,
        freshbooksInvoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: inv.amount.toFixed(2),
        paid: inv.paid.toFixed(2),
        balance: inv.balance.toFixed(2),
        currency: inv.currency,
        status: inv.status,
        issuedDate: inv.issuedDate,
        dueDate: inv.dueDate,
      },
      update: {
        invoiceNumber: inv.invoiceNumber,
        amount: inv.amount.toFixed(2),
        paid: inv.paid.toFixed(2),
        balance: inv.balance.toFixed(2),
        currency: inv.currency,
        status: inv.status,
        issuedDate: inv.issuedDate,
        dueDate: inv.dueDate,
        fetchedAt: new Date(),
        // Re-appearance of a previously soft-deleted invoice (rare — happens
        // when a FreshBooks vis_state flips back) reverts to live cleanly.
        active: true,
        voidedAt: null,
      },
    });
  }

  // Reconciliation: anything cached that FreshBooks no longer returns is
  // stale (deleted, voided, reassigned). We keep the row but flip
  // active=false and stamp voidedAt, so the UI can show history without
  // affecting any decision (the decision pipeline reads from FreshBooks,
  // not from the cache).
  const liveIds = invoices.map((inv) => inv.id);
  await prisma.invoiceCache.updateMany({
    where: {
      clientId,
      active: true,
      ...(liveIds.length > 0 ? { freshbooksInvoiceId: { notIn: liveIds } } : {}),
    },
    data: { active: false, voidedAt: new Date() },
  });
}

/**
 * Catch-up sweep — process WebhookEvent rows that were persisted but never
 * marked processed (e.g. server crashed mid-flight). Called once at boot.
 */
export async function catchUpUnprocessedEvents(opts?: { limit?: number }): Promise<number> {
  const limit = opts?.limit ?? 100;
  const stuck = await prisma.webhookEvent.findMany({
    where: { processed: false, failed: false },
    orderBy: { receivedAt: 'asc' },
    take: limit,
  });
  if (stuck.length === 0) return 0;
  logger.info({ n: stuck.length }, 'webhook.catchup.start');
  let ok = 0;
  for (const ev of stuck) {
    try {
      await processWebhookEvent(ev.id);
      ok += 1;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, eventId: ev.eventId },
        'webhook.catchup.failed',
      );
    }
  }
  logger.info({ ok, total: stuck.length }, 'webhook.catchup.done');
  return ok;
}
