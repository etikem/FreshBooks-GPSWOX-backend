import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { evaluateAndApply } from '../services/webhook.service';
import { manualReplay, cancel } from '../services/retry.service';

// ── auth ─────────────────────────────────────────────────────────────
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function login(req: Request, res: Response): Promise<void> {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  const { email, password } = parsed.data;
  if (email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const ok = await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH);
  if (!ok) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const token = jwt.sign({ email }, env.JWT_SECRET, { expiresIn: '12h' });
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
  status: z.enum(['ACTIVE', 'BLOCKED', 'CANCELLED', 'UNKNOWN']).optional(),
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

// ── logs ────────────────────────────────────────────────────────────
export async function listActionLogs(
  req: Request,
  res: Response,
): Promise<void> {
  const take = Math.min(Number(req.query.take ?? 100), 500);
  const items = await prisma.actionLog.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: { client: { select: { id: true, email: true } } },
  });
  res.json({ items });
}

export async function listWebhookEvents(
  req: Request,
  res: Response,
): Promise<void> {
  const take = Math.min(Number(req.query.take ?? 100), 500);
  const items = await prisma.webhookEvent.findMany({
    orderBy: { receivedAt: 'desc' },
    take,
  });
  res.json({ items });
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
