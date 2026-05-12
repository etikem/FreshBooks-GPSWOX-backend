import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { evaluateAndApply, processWebhookEvent } from '../services/webhook.service';
import { manualReplay, cancel } from '../services/retry.service';
import { logger } from '../utils/logger';

// ── auth ─────────────────────────────────────────────────────────────
const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function login(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  const { username, password } = parsed.data;
  if (username.toLowerCase() !== env.ADMIN_USERNAME.toLowerCase()) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const ok = await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH);
  if (!ok) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const token = jwt.sign({ username }, env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
}

// ── dashboard summary ───────────────────────────────────────────────
export async function getStats(_req: Request, res: Response): Promise<void> {
  const [totalClients, active, blocked, failedRetries, pendingRetries] =
    await Promise.all([
      prisma.client.count(),
      prisma.client.count({ where: { status: 'ACTIVE' } }),
      prisma.client.count({ where: { status: 'BLOCKED' } }),
      prisma.retryJob.count({ where: { status: 'FAILED' } }),
      prisma.retryJob.count({ where: { status: 'PENDING' } }),
    ]);

  const recentSyncs = await prisma.syncRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: 25,
    include: { client: { select: { id: true, email: true } } },
  });

  res.json({
    totals: { totalClients, active, blocked },
    retries: { pending: pendingRetries, failed: failedRetries },
    recentSyncs,
  });
}

// ── clients ─────────────────────────────────────────────────────────
const listClientsQuery = z.object({
  q: z.string().optional(),
  status: z
    .enum(['ACTIVE', 'BLOCKED', 'CANCELLED', 'UNKNOWN'])
    .optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export async function listClients(req: Request, res: Response): Promise<void> {
  const parsed = listClientsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid query' });
    return;
  }
  const { q, status, take, skip } = parsed.data;

  const where = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' as const } },
            { name: { contains: q, mode: 'insensitive' as const } },
            { freshbooksClientId: { contains: q } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      skip,
    }),
    prisma.client.count({ where }),
  ]);

  res.json({ items, total });
}

export async function getClientDetail(
  req: Request,
  res: Response,
): Promise<void> {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      invoices: { orderBy: { dueDate: 'desc' }, take: 100 },
      actionLogs: { orderBy: { createdAt: 'desc' }, take: 100 },
      paymentLogs: { orderBy: { createdAt: 'desc' }, take: 100 },
      retryJobs: { orderBy: { createdAt: 'desc' }, take: 100 },
      syncRuns: { orderBy: { startedAt: 'desc' }, take: 50 },
    },
  });
  if (!client) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(client);
}

// ── PATCH client (operator edits) ───────────────────────────────────
const patchClientSchema = z
  .object({
    contractStartDate: z.string().datetime().optional(),
    contractEndDate: z.string().datetime().optional(),
    // Operator override of status. Use sparingly — the access engine is the
    // source of truth; manual overrides are for emergency unblocks etc.
    status: z.enum(['ACTIVE', 'BLOCKED', 'CANCELLED', 'UNKNOWN']).optional(),
    // Manual unlimited flag — bypasses billing entirely. Toggling either
    // way triggers an immediate evaluateAndApply so ABC Track reflects the
    // change without waiting for the next webhook.
    isUnlimited: z.boolean().optional(),
  })
  .strict();

export async function patchClient(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    const parsed = patchClientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid body',
        details: parsed.error.flatten(),
      });
      return;
    }
    const data: Record<string, unknown> = {};
    if (parsed.data.contractStartDate) {
      data.contractStartDate = new Date(parsed.data.contractStartDate);
    }
    if (parsed.data.contractEndDate) {
      data.contractEndDate = new Date(parsed.data.contractEndDate);
    }
    if (parsed.data.status) {
      data.status = parsed.data.status;
    }
    if (typeof parsed.data.isUnlimited === 'boolean') {
      data.isUnlimited = parsed.data.isUnlimited;
    }
    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'no recognised fields' });
      return;
    }

    const updated = await prisma.client.update({
      where: { id },
      data,
    });

    await prisma.actionLog.create({
      data: {
        clientId: id,
        kind: 'MANUAL_SYNC',
        message: `Admin updated client fields: ${Object.keys(data).join(', ')}`,
        details: data as object,
      },
    });

    logger.info(
      { clientId: id, fields: Object.keys(data) },
      'admin.client.patched',
    );

    // If isUnlimited or status changed, propagate to ABC Track immediately
    // rather than waiting for the next webhook. Best-effort — patch
    // response still returns even if the downstream sync fails.
    if (
      typeof parsed.data.isUnlimited === 'boolean' ||
      parsed.data.status === 'ACTIVE' ||
      parsed.data.status === 'BLOCKED'
    ) {
      try {
        await evaluateAndApply({ clientId: id, trigger: 'MANUAL' });
      } catch (syncErr) {
        logger.warn(
          { clientId: id, err: (syncErr as Error).message },
          'admin.patch.sync-failed',
        );
      }
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
}

// ── manual sync ─────────────────────────────────────────────────────
export async function triggerManualSync(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    await prisma.actionLog.create({
      data: {
        clientId: id,
        kind: 'MANUAL_SYNC',
        message: 'Manual sync triggered from admin dashboard',
      },
    });
    await evaluateAndApply({ clientId: id, trigger: 'MANUAL' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ── notifications (aggregated) ──────────────────────────────────────
/**
 * Aggregated dashboard notifications. Pulls actionable items from
 * existing tables (clients, webhook_events, retry_jobs, sync_runs) so we
 * don't have to maintain a separate Notification table — every item
 * already has a row of truth elsewhere.
 *
 * Each section returns { count, sample } where `count` is the full count
 * (used for badges) and `sample` is the 10 newest entries for previews.
 */
export async function getNotifications(
  _req: Request,
  res: Response,
): Promise<void> {
  const SAMPLE = 10;

  const [
    cancelledCount,
    cancelledSample,
    webhookFailureCount,
    webhookFailureSample,
    failedRetryCount,
    failedRetrySample,
    syncErrorCount,
    syncErrorSample,
  ] = await Promise.all([
    prisma.client.count({ where: { status: 'CANCELLED' } }),
    prisma.client.findMany({
      where: { status: 'CANCELLED' },
      orderBy: { updatedAt: 'desc' },
      take: SAMPLE,
      select: { id: true, email: true, name: true, lastSyncedAt: true },
    }),
    prisma.webhookEvent.count({ where: { failed: true } }),
    prisma.webhookEvent.findMany({
      where: { failed: true },
      orderBy: { receivedAt: 'desc' },
      take: SAMPLE,
      select: {
        id: true,
        eventType: true,
        eventId: true,
        failureReason: true,
        receivedAt: true,
      },
    }),
    prisma.retryJob.count({ where: { status: 'FAILED' } }),
    prisma.retryJob.findMany({
      where: { status: 'FAILED' },
      orderBy: { updatedAt: 'desc' },
      take: SAMPLE,
      include: { client: { select: { id: true, email: true } } },
    }),
    prisma.syncRun.count({ where: { outcome: 'ERROR' } }),
    prisma.syncRun.findMany({
      where: { outcome: 'ERROR' },
      orderBy: { startedAt: 'desc' },
      take: SAMPLE,
      include: { client: { select: { id: true, email: true } } },
    }),
  ]);

  res.json({
    cancelled:        { count: cancelledCount,     sample: cancelledSample },
    webhookFailures:  { count: webhookFailureCount, sample: webhookFailureSample },
    failedRetries:    { count: failedRetryCount,    sample: failedRetrySample },
    recentSyncErrors: { count: syncErrorCount,      sample: syncErrorSample },
  });
}

// ── logs ────────────────────────────────────────────────────────────
const logsPageQuery = z.object({
  take: z.coerce.number().int().min(1).max(500).default(20),
  skip: z.coerce.number().int().min(0).default(0),
});

export async function listActionLogs(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = logsPageQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid query' });
    return;
  }
  const { take, skip } = parsed.data;
  const [items, total] = await Promise.all([
    prisma.actionLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: { client: { select: { id: true, email: true } } },
    }),
    prisma.actionLog.count(),
  ]);
  res.json({ items, total });
}

export async function listWebhookEvents(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = logsPageQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid query' });
    return;
  }
  const { take, skip } = parsed.data;
  const [items, total] = await Promise.all([
    prisma.webhookEvent.findMany({
      orderBy: { receivedAt: 'desc' },
      take,
      skip,
    }),
    prisma.webhookEvent.count(),
  ]);
  res.json({ items, total });
}

export async function replayWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'missing id' });
      return;
    }
    // Reset processed flags so processWebhookEvent re-enters the pipeline.
    await prisma.webhookEvent.update({
      where: { id },
      data: { processed: false, processedAt: null, failed: false, failureReason: null },
    });
    // Run inline so the operator gets immediate feedback.
    await processWebhookEvent(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ── retries ─────────────────────────────────────────────────────────
export async function listRetries(
  req: Request,
  res: Response,
): Promise<void> {
  const status = (req.query.status as string | undefined) ?? undefined;
  const items = await prisma.retryJob.findMany({
    where: status ? { status: status as any } : undefined,
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: { client: { select: { id: true, email: true } } },
  });
  res.json({ items });
}

export async function replayRetry(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }
  await manualReplay(id);
  res.json({ ok: true });
}

export async function cancelRetry(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }
  await cancel(id);
  res.json({ ok: true });
}
