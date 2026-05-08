import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { freshbooksService } from './freshbooks.service';
import { gpswoxService } from './gpswox.service';
import { clientMappingService } from './client-mapping.service';
import { decideAccess } from './balance.engine';
import { enqueueRetry } from './retry.service';
import { TransientHttpError } from '../utils/http';

/**
 * Verifies the FreshBooks webhook HMAC. The header name varies by API
 * version; we accept both common spellings.
 */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = crypto
    .createHmac('sha256', env.FRESHBOOKS_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  // timing-safe compare
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface IncomingWebhook {
  rawBody: Buffer;
  signature: string | undefined;
  parsed: Record<string, unknown>;
}

/**
 * Top-level: persist + dedupe + dispatch.
 *
 * Idempotency: we rely on the (source, eventId) unique index on
 * WebhookEvent. If two requests arrive for the same event, the second
 * insert throws and we treat the event as already-handled.
 */
export async function ingestWebhook(input: IncomingWebhook): Promise<{
  duplicate: boolean;
  webhookEventId: string;
}> {
  const eventId = extractEventId(input.parsed);
  const eventType = String(
    input.parsed.event_type ?? input.parsed.name ?? 'unknown',
  );

  try {
    const created = await prisma.webhookEvent.create({
      data: {
        source: 'freshbooks',
        eventId,
        eventType,
        rawPayload: input.parsed as Prisma.InputJsonValue,
        signature: input.signature ?? null,
      },
    });
    return { duplicate: false, webhookEventId: created.id };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const existing = await prisma.webhookEvent.findUnique({
        where: { source_eventId: { source: 'freshbooks', eventId } },
      });
      logger.info({ eventId }, 'webhook.duplicate');
      return { duplicate: true, webhookEventId: existing!.id };
    }
    throw err;
  }
}

function extractEventId(payload: Record<string, unknown>): string {
  const id =
    payload.event_id ??
    payload.eventId ??
    (payload.object as Record<string, unknown> | undefined)?.id ??
    payload.id;
  if (!id) {
    // Hash the body as a last resort so we still dedupe identical replays.
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
  }
  return String(id);
}

/**
 * Process the event end-to-end. The webhook controller calls this AFTER
 * acknowledging the HTTP request to FreshBooks (so a slow GPSWOX call
 * never causes FreshBooks to retry). Errors here are captured into the
 * retry queue rather than thrown to the HTTP layer.
 */
export async function processWebhookEvent(webhookEventId: string): Promise<void> {
  const ev = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
  });
  if (!ev || ev.processed) return;

  const payload = ev.rawPayload as Record<string, unknown>;
  const obj =
    (payload.object as Record<string, unknown> | undefined) ?? payload;
  const eventType = ev.eventType.toLowerCase();
  const isClientEvent = /(^|\.)(client|user)(\.|$)/.test(eventType);
  const isDelete = /(delete|destroy)/.test(eventType);

  // For client events, the object IS the client; otherwise the customer
  // field on the invoice/payment tells us which client to refresh.
  const freshbooksClientId = isClientEvent
    ? ((obj.id as string | number | undefined) ??
        (obj.userid as string | number | undefined) ??
        (obj.user_id as string | number | undefined))?.toString()
    : ((obj.userid as string | undefined) ??
        (obj.customerid as string | undefined) ??
        (obj.client_id as string | undefined) ??
        (obj.clientid as string | undefined));
  const email = (obj.email as string | undefined) ?? undefined;

  let client = await clientMappingService.identifyFromPayload({
    freshbooksClientId,
    email,
  });

  // Client deleted in FreshBooks → mark CANCELLED locally and stop.
  // We don't remove the row so historical SyncRuns / ActionLogs survive.
  if (isClientEvent && isDelete) {
    if (client) {
      await prisma.client.update({
        where: { id: client.id },
        data: { status: 'CANCELLED', lastSyncedAt: new Date() },
      });
      await prisma.actionLog.create({
        data: {
          clientId: client.id,
          kind: 'DECISION_BLOCK',
          message: 'Client deleted in FreshBooks — marked CANCELLED.',
          details: { eventId: ev.eventId },
        },
      });
    }
    await prisma.webhookEvent.update({
      where: { id: ev.id },
      data: { processed: true, processedAt: new Date() },
    });
    return;
  }

  // Client.create / .update for someone we don't have, OR an invoice/payment
  // event referencing an unknown client — fetch from FreshBooks and upsert.
  if (!client && freshbooksClientId) {
    client = await ensureClientFromFreshbooks(freshbooksClientId);
  }
  // Client.update for a client we already have — refresh metadata too.
  else if (client && isClientEvent) {
    client = await ensureClientFromFreshbooks(client.freshbooksClientId);
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

  await evaluateAndApply({
    clientId: client.id,
    trigger: 'WEBHOOK',
    webhookEventId: ev.id,
  });

  await prisma.webhookEvent.update({
    where: { id: ev.id },
    data: { processed: true, processedAt: new Date() },
  });
}

/**
 * Fetch a client from FreshBooks and upsert into our DB. Used by the
 * webhook handler so client.create / .update events propagate, and so
 * invoice events for clients we don't yet have don't get dropped.
 */
async function ensureClientFromFreshbooks(
  freshbooksClientId: string,
): Promise<Awaited<ReturnType<typeof clientMappingService.findByFreshbooksClientId>>> {
  const tenant = await prisma.tenant.findFirst({
    where: { freshbooksAccountId: env.FRESHBOOKS_ACCOUNT_ID },
  });
  if (!tenant) {
    logger.warn('webhook.no-tenant — run sync:clients once to seed a Tenant row');
    return null;
  }
  const raw = await freshbooksService.getClient(freshbooksClientId);
  if (!raw) return null;

  const email = (raw.email as string | undefined)?.trim().toLowerCase();
  if (!email) return null;

  const fname = (raw.fname as string | undefined) ?? null;
  const lname = (raw.lname as string | undefined) ?? null;
  const org = (raw.organization as string | undefined)?.trim();
  const human = [fname, lname].filter(Boolean).join(' ').trim();
  const name = org || human || null;

  const signupRaw = raw.signup_date as string | undefined;
  const signup = signupRaw ? new Date(signupRaw) : new Date();
  const safeSignup = isNaN(signup.getTime()) ? new Date() : signup;
  const contractEnd = new Date(safeSignup);
  contractEnd.setFullYear(contractEnd.getFullYear() + 1);

  return prisma.client.upsert({
    where: {
      tenantId_freshbooksClientId: {
        tenantId: tenant.id,
        freshbooksClientId,
      },
    },
    update: { email, name },
    create: {
      tenantId: tenant.id,
      email,
      name,
      freshbooksClientId,
      contractStartDate: safeSignup,
      contractEndDate: contractEnd,
    },
  });
}

/**
 * The single decision pipeline used by the webhook handler, the manual
 * sync admin endpoint, and a future cron sweep. Always:
 *
 *   1. Refetch invoices from FreshBooks (truth).
 *   2. Compute outstanding via BalanceEngine.
 *   3. Apply the decision to GPSWOX.
 *   4. Update the Client row.
 *   5. Persist a SyncRun record.
 *
 * If FreshBooks itself is unreachable we BLOCK and enqueue a retry — we
 * NEVER act on stale state.
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
    const invoices = await freshbooksService.listInvoicesForClient(
      client.freshbooksClientId,
    );

    // Refresh the local cache for the dashboard. This is best-effort.
    await refreshInvoiceCache(client.id, invoices).catch((e) =>
      logger.warn({ err: e?.message }, 'invoice-cache.refresh.failed'),
    );

    const decision = decideAccess({
      invoices,
      contractEndDate: client.contractEndDate,
      now: new Date(),
    });

    await prisma.actionLog.create({
      data: {
        clientId: client.id,
        kind: decision.shouldRestore ? 'DECISION_RESTORE' : 'DECISION_BLOCK',
        message: decision.reason,
        details: {
          outstanding: decision.outstanding.toFixed(2),
          paidThroughDate: decision.paidThroughDate?.toISOString() ?? null,
          perInvoice: decision.perInvoice as object,
        },
      },
    });

    if (decision.shouldRestore && decision.effectiveAccessExpiresAt) {
      if (!client.gpswoxUserId) {
        throw new Error(
          'Client is mapped to FreshBooks but has no gpswoxUserId — refusing to act.',
        );
      }
      await applyEnable({
        clientId: client.id,
        gpswoxUserId: client.gpswoxUserId,
        accessExpiresAt: decision.effectiveAccessExpiresAt,
      });
      await prisma.client.update({
        where: { id: client.id },
        data: {
          status: 'ACTIVE',
          lastOutstanding: decision.outstanding.toFixed(2),
          paidThroughDate: decision.paidThroughDate,
          accessExpiresAt: decision.effectiveAccessExpiresAt,
          lastSyncedAt: new Date(),
        },
      });
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          outcome: 'RESTORED',
          outstanding: decision.outstanding.toFixed(2),
          paidThroughDate: decision.paidThroughDate,
          finishedAt: new Date(),
          notes: decision.reason,
        },
      });
    } else {
      // BLOCK path. Note: we still call disable so a previously-enabled
      // user is positively shut off if they fall into arrears.
      if (client.gpswoxUserId && client.status !== 'BLOCKED') {
        await applyDisable({
          clientId: client.id,
          gpswoxUserId: client.gpswoxUserId,
        });
      }
      await prisma.client.update({
        where: { id: client.id },
        data: {
          status: 'BLOCKED',
          lastOutstanding: decision.outstanding.toFixed(2),
          paidThroughDate: decision.paidThroughDate ?? client.paidThroughDate,
          lastSyncedAt: new Date(),
        },
      });
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          outcome: 'BLOCKED',
          outstanding: decision.outstanding.toFixed(2),
          paidThroughDate: decision.paidThroughDate,
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
    // Only retry on transient errors. Permanent errors (e.g. unknown
    // GPSWOX user id) need human attention.
    if (err instanceof TransientHttpError) {
      throw err; // bubble to the controller, which will enqueue a retry
    }
  }
}

async function applyEnable(args: {
  clientId: string;
  gpswoxUserId: string;
  accessExpiresAt: Date;
}): Promise<void> {
  try {
    await gpswoxService.enable(args);
  } catch (err) {
    if (err instanceof TransientHttpError) {
      await enqueueRetry({
        clientId: args.clientId,
        operation: 'gpswox.enable',
        payload: {
          gpswoxUserId: args.gpswoxUserId,
          accessExpiresAt: args.accessExpiresAt.toISOString(),
        },
        idempotencyKey: `enable:${args.clientId}:${args.accessExpiresAt.toISOString()}`,
        initialError: err.message,
      });
      return;
    }
    throw err;
  }
}

async function applyDisable(args: {
  clientId: string;
  gpswoxUserId: string;
}): Promise<void> {
  try {
    await gpswoxService.disable(args);
  } catch (err) {
    if (err instanceof TransientHttpError) {
      await enqueueRetry({
        clientId: args.clientId,
        operation: 'gpswox.disable',
        payload: { gpswoxUserId: args.gpswoxUserId },
        idempotencyKey: `disable:${args.clientId}`,
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
      },
    });
  }

  // Reconciliation: anything cached that FreshBooks no longer returns is
  // stale (deleted, voided, reassigned). Drop it so the UI matches truth.
  // Only safe to do when the fetch above succeeded — this function only
  // runs on the success path of evaluateAndApply.
  const liveIds = invoices.map((inv) => inv.id);
  await prisma.invoiceCache.deleteMany({
    where: {
      clientId,
      ...(liveIds.length > 0 ? { freshbooksInvoiceId: { notIn: liveIds } } : {}),
    },
  });
}
