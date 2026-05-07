/**
 * One-shot script: pull every customer from FreshBooks and upsert them
 * into the local `clients` table.
 *
 * Run with: npm run sync:clients   (from the backend/ directory)
 *
 * Idempotent — safe to re-run. Existing rows are matched on
 * (tenantId, freshbooksClientId) and only have their email/name refreshed,
 * so contract dates and status set elsewhere are preserved.
 */
import 'dotenv/config';
import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { freshbooksService } from '../services/freshbooks.service';

interface FreshbooksClientRaw {
  id?: number | string;
  userid?: number | string;
  email?: string | null;
  fname?: string | null;
  lname?: string | null;
  organization?: string | null;
  signup_date?: string | null;
  updated?: string | null;
  vis_state?: number; // 0 = active, 1 = deleted, 2 = archived
}

interface FreshbooksClientsResponse {
  response?: {
    result?: {
      clients?: FreshbooksClientRaw[];
      page?: number;
      pages?: number;
      per_page?: number;
      total?: number;
    };
  };
}

function buildHttp(): AxiosInstance {
  return axios.create({
    baseURL: env.FRESHBOOKS_API_BASE,
    timeout: 20_000,
    headers: {
      Authorization: `Bearer ${env.FRESHBOOKS_API_TOKEN}`,
      'Api-Version': 'alpha',
      'content-type': 'application/json',
    },
  });
}

async function fetchAllClients(http: AxiosInstance): Promise<FreshbooksClientRaw[]> {
  const accountId = env.FRESHBOOKS_ACCOUNT_ID;
  const all: FreshbooksClientRaw[] = [];
  const perPage = 100;
  const maxPages = 200;
  let page = 1;

  while (page <= maxPages) {
    const url = `/accounting/account/${accountId}/users/clients`;
    const res = await http.get<FreshbooksClientsResponse>(url, {
      params: { per_page: perPage, page },
    });
    const result = res.data?.response?.result;
    const batch = result?.clients ?? [];
    all.push(...batch);

    const totalPages = Number(result?.pages ?? 1);
    logger.info(
      { page, totalPages, batchSize: batch.length, accumulated: all.length },
      'freshbooks.clients.page',
    );
    if (page >= totalPages || batch.length === 0) break;
    page += 1;
  }

  return all;
}

function pickName(raw: FreshbooksClientRaw): string | null {
  const org = raw.organization?.trim();
  if (org) return org;
  const human = [raw.fname, raw.lname].filter(Boolean).join(' ').trim();
  return human || null;
}

function parseDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

async function ensureTenant(): Promise<{ id: string }> {
  const existing = await prisma.tenant.findFirst({
    where: { freshbooksAccountId: env.FRESHBOOKS_ACCOUNT_ID },
  });
  if (existing) return existing;
  return prisma.tenant.create({
    data: {
      name: `FreshBooks ${env.FRESHBOOKS_ACCOUNT_ID}`,
      freshbooksAccountId: env.FRESHBOOKS_ACCOUNT_ID,
    },
  });
}

async function syncInvoices(tenantId: string): Promise<{
  invoicesInserted: number;
  invoicesUpdated: number;
  invoicesDeleted: number;
  clientsFailed: number;
}> {
  const clients = await prisma.client.findMany({
    where: { tenantId },
    select: { id: true, freshbooksClientId: true, email: true },
  });

  let invoicesInserted = 0;
  let invoicesUpdated = 0;
  let invoicesDeleted = 0;
  let clientsFailed = 0;

  for (const client of clients) {
    try {
      const invoices = await freshbooksService.listInvoicesForClient(
        client.freshbooksClientId,
      );

      for (const inv of invoices) {
        const existing = await prisma.invoiceCache.findUnique({
          where: {
            clientId_freshbooksInvoiceId: {
              clientId: client.id,
              freshbooksInvoiceId: inv.id,
            },
          },
          select: { id: true },
        });

        const data = {
          invoiceNumber: inv.invoiceNumber,
          amount: inv.amount.toString(),
          paid: inv.paid.toString(),
          balance: inv.balance.toString(),
          currency: inv.currency,
          status: inv.status,
          issuedDate: inv.issuedDate,
          dueDate: inv.dueDate,
        };

        if (existing) {
          await prisma.invoiceCache.update({
            where: { id: existing.id },
            data: { ...data, fetchedAt: new Date() },
          });
          invoicesUpdated += 1;
        } else {
          await prisma.invoiceCache.create({
            data: {
              clientId: client.id,
              freshbooksInvoiceId: inv.id,
              ...data,
            },
          });
          invoicesInserted += 1;
        }
      }

      // Reconciliation: anything cached locally that FreshBooks no longer
      // returns (deleted or moved to another customer) is stale. Drop it.
      // Only runs when the fetch above succeeded — on a partial / failed
      // pull we'd rather keep stale rows than over-delete.
      const liveIds = invoices.map((inv) => inv.id);
      const deleteResult = await prisma.invoiceCache.deleteMany({
        where: {
          clientId: client.id,
          ...(liveIds.length > 0
            ? { freshbooksInvoiceId: { notIn: liveIds } }
            : {}),
        },
      });
      invoicesDeleted += deleteResult.count;
    } catch (err) {
      clientsFailed += 1;
      logger.warn(
        {
          clientId: client.id,
          email: client.email,
          err: err instanceof Error ? err.message : String(err),
        },
        'sync.invoices.client.failed',
      );
    }
  }

  return { invoicesInserted, invoicesUpdated, invoicesDeleted, clientsFailed };
}

async function main(): Promise<void> {
  const http = buildHttp();
  const tenant = await ensureTenant();
  logger.info({ tenantId: tenant.id }, 'sync.tenant.ready');

  const clients = await fetchAllClients(http);
  logger.info({ count: clients.length }, 'sync.fetched');

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const raw of clients) {
    const fbId = raw.id ?? raw.userid;
    if (fbId === undefined || fbId === null) {
      skipped += 1;
      continue;
    }
    // Skip soft-deleted clients (FreshBooks marks vis_state = 1).
    if (raw.vis_state === 1) {
      skipped += 1;
      continue;
    }
    const email = raw.email?.trim().toLowerCase();
    if (!email) {
      // Email is required by the schema. Without one we can't reconcile
      // payments back to a client, so skip.
      skipped += 1;
      continue;
    }

    const freshbooksClientId = String(fbId);
    const name = pickName(raw);
    const signup = parseDateOrNull(raw.signup_date) ?? new Date();
    // FreshBooks doesn't expose a contract-end date; default to one year
    // from signup. Operators can refine via the admin UI later.
    const contractEnd = new Date(signup);
    contractEnd.setFullYear(contractEnd.getFullYear() + 1);

    const result = await prisma.client.upsert({
      where: {
        tenantId_freshbooksClientId: {
          tenantId: tenant.id,
          freshbooksClientId,
        },
      },
      update: {
        email,
        name,
      },
      create: {
        tenantId: tenant.id,
        email,
        name,
        freshbooksClientId,
        contractStartDate: signup,
        contractEndDate: contractEnd,
      },
      select: { createdAt: true, updatedAt: true },
    });

    if (result.createdAt.getTime() === result.updatedAt.getTime()) {
      inserted += 1;
    } else {
      updated += 1;
    }
  }

  logger.info({ inserted, updated, skipped, total: clients.length }, 'sync.clients.done');

  const invoiceStats = await syncInvoices(tenant.id);
  logger.info(invoiceStats, 'sync.invoices.done');
}

main()
  .catch((err) => {
    logger.error({ err: err?.message ?? err, stack: err?.stack }, 'sync.failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
