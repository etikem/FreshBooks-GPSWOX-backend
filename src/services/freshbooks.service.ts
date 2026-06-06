import { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  createHttpClient,
  getHttpStats,
  PermanentHttpError,
  TransientHttpError,
  type HttpStats,
} from '../utils/http';
import { toMoney } from '../utils/decimal';
import type { FreshbooksInvoice } from '../types';
import {
  getAccessToken,
  refreshFreshbooksToken,
} from './freshbooks-token.service';

// 401 here means the refresh-and-retry already ran once and STILL failed —
// at that point the problem is no longer "expired access token". It's almost
// always a revoked grant or insufficient scope, and the operator must
// re-authorize the app. 403 stays an auth error (insufficient scope).
const REAUTH_HINT =
  'FreshBooks rejected the call with 401 even after a token refresh+retry. ' +
  'The grant is likely revoked or out of scope — re-authorize the app and ' +
  'reseed FRESHBOOKS_API_TOKEN / FRESHBOOKS_API_REFRESH_TOKEN.';

function rewriteAuthError(err: unknown): unknown {
  const status = (err as { status?: number }).status;
  if (status === 401 || status === 403) {
    return new PermanentHttpError(REAUTH_HINT, status);
  }
  return err;
}

/**
 * FreshBooksService is the ONLY layer that talks to FreshBooks.
 *
 * Critical invariant: webhooks are *triggers*, never *truth*. Every decision
 * path must call `listInvoicesForClient` to get fresh state, even if the
 * webhook payload appears to contain the same data. A webhook can be:
 *   - delayed (out of order)
 *   - replayed
 *   - spoofed
 *   - missing fields
 *   - reflecting a stale view of the world
 *
 * The FreshBooks REST API is the system of record.
 */
export class FreshBooksService {
  private readonly http: AxiosInstance;
  private readonly accountId: string;
  private readonly businessId: string;

  constructor() {
    this.accountId = env.FRESHBOOKS_ACCOUNT_ID;
    this.businessId = env.FRESHBOOKS_BUSINESS_ID;
    this.http = createHttpClient({
      name: 'freshbooks',
      baseURL: env.FRESHBOOKS_API_BASE,
      timeoutMs: 20_000,
      defaultHeaders: {
        'Api-Version': 'alpha',
      },
      // Inject the current access token on every request. The token
      // service caches in memory (~30s) and falls back to the DB row,
      // so token rotations performed by other nodes are picked up
      // without us having to do anything.
      getAuthHeader: async () => `Bearer ${await getAccessToken()}`,
      // On 401, run the OAuth refresh dance. The token service handles
      // both in-process coalescing and the cross-node Postgres advisory
      // lock — only one node in the cluster will actually call the
      // OAuth endpoint, regardless of how many in-flight requests 401
      // simultaneously.
      onUnauthorized: async () => {
        await refreshFreshbooksToken();
      },
      // Proactively stay under FreshBooks' rate limit, and transparently
      // retry the 429s that still slip through (honouring Retry-After).
      rateLimitPerSec: env.FRESHBOOKS_RATE_LIMIT_RPS,
      maxRetries: env.FRESHBOOKS_MAX_RETRIES,
    });
  }

  /** Live request stats (total requests, rate-limit hits) for run summaries. */
  getRequestStats(): HttpStats {
    return getHttpStats(this.http);
  }

  /**
   * Fetch a single client. Returns null on 404 (deleted/unknown).
   * Used by the webhook handler when a client.create/update arrives for an
   * id we don't yet have in the DB.
   */
  async getClient(freshbooksClientId: string): Promise<Record<string, unknown> | null> {
    const url = `/accounting/account/${this.accountId}/users/clients/${freshbooksClientId}`;
    try {
      const res = await this.http.get(url);
      const result = res.data?.response?.result ?? res.data?.response ?? res.data;
      return (result?.client ?? result?.userclient ?? null) as Record<string, unknown> | null;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw rewriteAuthError(err);
    }
  }

  /**
   * Fetch a single invoice and return its FreshBooks customerid. The
   * form-encoded webhook payload only carries the invoice id (`object_id`)
   * and a staff `user_id` — the actual customer is only available by
   * looking the invoice up.
   *
   * Returns null on 404 (e.g. hard-deleted invoice) or when the invoice
   * has no customerid.
   */
  async getInvoiceCustomerId(invoiceId: string): Promise<string | null> {
    const url = `/accounting/account/${this.accountId}/invoices/invoices/${invoiceId}`;
    try {
      const res = await this.http.get(url);
      const result = res.data?.response?.result ?? res.data?.response ?? res.data;
      const invoice = result?.invoice as Record<string, unknown> | undefined;
      const customerid = invoice?.customerid;
      return customerid !== undefined && customerid !== null ? String(customerid) : null;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw rewriteAuthError(err);
    }
  }

  /**
   * Fetch a single payment. Same form-encoded problem as invoices: the
   * webhook only carries the payment id, so we have to GET the payment to
   * find out which client it belongs to AND to record the real amount/date
   * on the PaymentLog audit row.
   *
   * Returns null on 404.
   */
  async getPayment(paymentId: string): Promise<Record<string, unknown> | null> {
    const url = `/accounting/account/${this.accountId}/payments/payments/${paymentId}`;
    try {
      const res = await this.http.get(url);
      const result = res.data?.response?.result ?? res.data?.response ?? res.data;
      return (result?.payment ?? null) as Record<string, unknown> | null;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw rewriteAuthError(err);
    }
  }

  /**
   * Fetch ALL payments for a given FreshBooks client (paginates internally).
   * Used by the backfill script and the manual-sync path to reconcile our
   * local PaymentLog table against FreshBooks. Throws on transient errors
   * so the caller can enqueue a retry.
   *
   * Returns minimal-shape rows — id, paidAt, amount, currency, invoiceId.
   * The rawPayload field on PaymentLog stores the full record.
   */
  async listPaymentsForClient(freshbooksClientId: string): Promise<
    Array<{
      id: string;
      paidAt: Date | null;
      amount: import('decimal.js').default | null;
      currency: string;
      invoiceId: string | null;
      raw: Record<string, unknown>;
    }>
  > {
    const all: Array<{
      id: string;
      paidAt: Date | null;
      amount: import('decimal.js').default | null;
      currency: string;
      invoiceId: string | null;
      raw: Record<string, unknown>;
    }> = [];
    let page = 1;
    const perPage = 100;
    const maxPages = 200;

    while (page <= maxPages) {
      const url = `/accounting/account/${this.accountId}/payments/payments`;
      let res;
      try {
        res = await this.http.get(url, {
          params: {
            'search[clientid]': freshbooksClientId,
            per_page: perPage,
            page,
          },
        });
      } catch (err) {
        throw rewriteAuthError(err);
      }

      const result = res.data?.response?.result ?? res.data?.response ?? res.data;
      const payments = (result?.payments ?? []) as unknown[];
      const totalPages = Number(result?.pages ?? 1);

      for (const raw of payments) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        // Skip soft-deleted payments — FreshBooks marks reversals as vis_state=1.
        const visState = Number(r.vis_state ?? 0);
        if (visState === 1) continue;
        const id = (r.id ?? r.paymentid) as string | number | undefined;
        if (id === undefined) continue;
        all.push({
          id: String(id),
          paidAt: parseDate(r.date ?? r.paid_date ?? r.created_at),
          amount: readMoney(r.amount),
          currency:
            ((typeof r.amount === 'object' && r.amount && 'code' in (r.amount as object)
              ? (r.amount as { code?: string }).code
              : (r.currency_code as string | undefined)) as string | undefined) ?? 'USD',
          invoiceId:
            (r.invoiceid as string | number | undefined)?.toString() ??
            (r.invoice_id as string | undefined) ??
            null,
          raw: r,
        });
      }

      if (page >= totalPages) break;
      page += 1;
    }

    logger.info(
      { freshbooksClientId, count: all.length },
      'freshbooks.payments.fetched',
    );
    return all;
  }

  /**
   * Fetch ALL invoices for a given FreshBooks client (paginates internally).
   * Throws on transient errors so the caller can enqueue a retry.
   */
  async listInvoicesForClient(freshbooksClientId: string): Promise<FreshbooksInvoice[]> {
    const all: FreshbooksInvoice[] = [];
    let page = 1;
    const perPage = 100;
    // Hard cap to prevent runaway loops on a buggy API.
    const maxPages = 200;

    while (page <= maxPages) {
      const url = `/accounting/account/${this.accountId}/invoices/invoices`;
      let res;
      try {
        res = await this.http.get(url, {
          params: {
            // FreshBooks search filter. Field name varies per API version;
            // we use the documented `customerid` filter.
            'search[customerid]': freshbooksClientId,
            per_page: perPage,
            page,
            // Include lines/payments so the balance is authoritative.
            // FreshBooks requires the array form `include[]=lines` — the
            // comma/string form is silently ignored and returns zero lines.
            include: ['lines', 'payments'],
          },
        });
      } catch (err) {
        throw rewriteAuthError(err);
      }

      const result = res.data?.response?.result ?? res.data?.response ?? res.data;
      const invoices = (result?.invoices ?? []) as unknown[];
      const totalPages = Number(result?.pages ?? 1);

      for (const raw of invoices) {
        const parsed = this.parseInvoice(raw);
        if (parsed) all.push(parsed);
      }

      if (page >= totalPages) break;
      page += 1;
    }

    logger.info(
      { freshbooksClientId, count: all.length },
      'freshbooks.invoices.fetched',
    );
    return all;
  }

  /**
   * Look a client up by email. FreshBooks supports a server-side
   * `search[email]` filter so we don't have to page the whole roster.
   *
   * The filter can match loosely, so we narrow to an exact (case-insensitive)
   * email match before declaring a client "present". Returns the matched raw
   * client (or null) plus the raw `total` the API reported — the reconciliation
   * sweep treats "no exact match" as missing-from-FreshBooks.
   */
  async findClientByEmail(
    email: string,
  ): Promise<{ client: Record<string, unknown> | null; total: number }> {
    const { clients, total } = await this.findClientsByEmail(email);
    return { client: clients[0] ?? null, total };
  }

  /**
   * Like `findClientByEmail`, but returns EVERY non-deleted FreshBooks client
   * whose email exactly matches — FreshBooks allows two distinct clients to
   * share one email (e.g. a personal client and an organization). The
   * reconciliation sweep must sum the device billing across all of them,
   * otherwise it sees only one client's invoice and reports a false mismatch.
   *
   * Soft-deleted clients (vis_state === 1) are excluded so their stale
   * invoices don't inflate the billed quantity.
   */
  async findClientsByEmail(
    email: string,
  ): Promise<{ clients: Record<string, unknown>[]; total: number }> {
    const norm = email.trim().toLowerCase();
    if (!norm) return { clients: [], total: 0 };
    const url = `/accounting/account/${this.accountId}/users/clients`;
    let res;
    try {
      res = await this.http.get(url, {
        params: { 'search[email]': norm, per_page: 100, page: 1 },
      });
    } catch (err) {
      throw rewriteAuthError(err);
    }
    const result = res.data?.response?.result ?? res.data?.response ?? res.data;
    const raw = (result?.clients ?? []) as Record<string, unknown>[];
    const total = Number(result?.total ?? raw.length);
    const clients = raw.filter(
      (c) =>
        String(c.email ?? '').trim().toLowerCase() === norm &&
        Number(c.vis_state ?? 0) !== 1,
    );
    return { clients, total };
  }

  /**
   * Compute the device billing quantity for a client: the sum of the qty of
   * every line named `RECONCILE_DEVICE_LINE_NAME` on the client's most recent
   * (non-deleted) invoice. We use the latest invoice rather than summing
   * across months because each monthly invoice repeats the same device line —
   * the latest one reflects what's currently billed.
   *
   * Returns `hasInvoices: false` (qty 0) when the client has no live invoices.
   */
  async getDeviceBillingForClient(freshbooksClientId: string): Promise<{
    qty: number;
    hasInvoices: boolean;
    invoiceId: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
  }> {
    const url = `/accounting/account/${this.accountId}/invoices/invoices`;
    let res;
    try {
      res = await this.http.get(url, {
        params: {
          'search[customerid]': freshbooksClientId,
          per_page: 100,
          page: 1,
          // Array form is required — `include=lines` is ignored by FreshBooks
          // and yields zero lines, which silently zeroes the device qty.
          include: ['lines'],
        },
      });
    } catch (err) {
      throw rewriteAuthError(err);
    }
    const result = res.data?.response?.result ?? res.data?.response ?? res.data;
    const invoices = (result?.invoices ?? []) as Record<string, unknown>[];
    return deviceBillingFromInvoiceRows(invoices);
  }

  /**
   * Fetch EVERY client on the account, paginating through all pages. Returns
   * the raw client records (non-deleted). Used by the reconciliation sweep to
   * build an email→client map in one bulk pass instead of one
   * `/users/clients?search[email]=` call per ABC Track client (which was the
   * call that tripped the rate limit).
   */
  async listAllClients(): Promise<Record<string, unknown>[]> {
    const url = `/accounting/account/${this.accountId}/users/clients`;
    const perPage = env.FRESHBOOKS_PAGE_SIZE;
    const maxPages = 500;
    const all: Record<string, unknown>[] = [];
    let page = 1;

    while (page <= maxPages) {
      let res;
      try {
        res = await this.http.get(url, { params: { per_page: perPage, page } });
      } catch (err) {
        throw rewriteAuthError(err);
      }
      const result = res.data?.response?.result ?? res.data?.response ?? res.data;
      const clients = (result?.clients ?? []) as Record<string, unknown>[];
      const totalPages = Number(result?.pages ?? 1);
      for (const c of clients) {
        if (Number(c.vis_state ?? 0) !== 1) all.push(c);
      }
      logger.info(
        { page, totalPages, pageCount: clients.length, accumulated: all.length },
        'freshbooks.clients.page',
      );
      if (page >= totalPages || clients.length === 0) break;
      page += 1;
    }

    logger.info({ count: all.length }, 'freshbooks.clients.fetched_all');
    return all;
  }

  /**
   * Fetch invoices across the WHOLE account, paginating through all pages.
   * Optionally limited to invoices created within `sinceDays` (0/undefined =
   * all). Returns raw rows with line items included so the caller can compute
   * each client's latest-invoice device quantity without a per-client call.
   */
  async listAllInvoices(opts?: { sinceDays?: number }): Promise<Record<string, unknown>[]> {
    const url = `/accounting/account/${this.accountId}/invoices/invoices`;
    const perPage = env.FRESHBOOKS_PAGE_SIZE;
    const maxPages = 1000;
    const all: Record<string, unknown>[] = [];
    let page = 1;

    const params: Record<string, unknown> = {
      per_page: perPage,
      // Array form is mandatory; `include=lines` is silently ignored.
      include: ['lines'],
    };
    if (opts?.sinceDays && opts.sinceDays > 0) {
      const since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000);
      params['search[date_min]'] = since.toISOString().slice(0, 10);
    }

    while (page <= maxPages) {
      let res;
      try {
        res = await this.http.get(url, { params: { ...params, page } });
      } catch (err) {
        throw rewriteAuthError(err);
      }
      const result = res.data?.response?.result ?? res.data?.response ?? res.data;
      const invoices = (result?.invoices ?? []) as Record<string, unknown>[];
      const totalPages = Number(result?.pages ?? 1);
      for (const inv of invoices) {
        if (Number(inv.vis_state ?? 0) !== 1) all.push(inv);
      }
      logger.info(
        { page, totalPages, pageCount: invoices.length, accumulated: all.length },
        'freshbooks.invoices.page',
      );
      if (page >= totalPages || invoices.length === 0) break;
      page += 1;
    }

    logger.info({ count: all.length }, 'freshbooks.invoices.fetched_all');
    return all;
  }

  /**
   * Compute device billing from a set of raw invoice rows already in hand
   * (e.g. grouped out of `listAllInvoices`). Same latest-invoice logic as
   * `getDeviceBillingForClient`, minus the network call.
   */
  deviceBillingFromRows(rows: Record<string, unknown>[]): DeviceBilling {
    return deviceBillingFromInvoiceRows(rows);
  }

  /**
   * Sum the device billing across several FreshBooks clients — used when more
   * than one client shares an email. Each client is billed on its own
   * recurring invoice, so the true device count for that email is the sum of
   * every client's latest-invoice quantity.
   *
   * Returns the combined qty plus a per-client breakdown, and surfaces the
   * single most recent invoice across all clients for display.
   */
  async getDeviceBillingForClients(freshbooksClientIds: string[]): Promise<{
    qty: number;
    hasInvoices: boolean;
    invoiceNumber: string | null;
    invoiceDate: string | null;
    perClient: Array<{
      freshbooksClientId: string;
      qty: number;
      hasInvoices: boolean;
      invoiceNumber: string | null;
      invoiceDate: string | null;
    }>;
  }> {
    const perClient = [];
    let qty = 0;
    let hasInvoices = false;
    for (const id of freshbooksClientIds) {
      const b = await this.getDeviceBillingForClient(id);
      qty += b.qty;
      hasInvoices = hasInvoices || b.hasInvoices;
      perClient.push({
        freshbooksClientId: id,
        qty: b.qty,
        hasInvoices: b.hasInvoices,
        invoiceNumber: b.invoiceNumber,
        invoiceDate: b.invoiceDate,
      });
    }
    // Representative invoice = the most recent one across all clients.
    const latest = perClient
      .filter((p) => p.invoiceDate)
      .sort((a, b) => Date.parse(b.invoiceDate!) - Date.parse(a.invoiceDate!))[0];
    return {
      qty,
      hasInvoices,
      invoiceNumber: latest?.invoiceNumber ?? null,
      invoiceDate: latest?.invoiceDate ?? null,
      perClient,
    };
  }

  /**
   * Parse a single FreshBooks invoice response into our typed shape.
   * Returns null if the structure is unrecognisable — caller treats this
   * as ambiguity (BLOCK).
   */
  private parseInvoice(raw: unknown): FreshbooksInvoice | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const id = (r.id ?? r.invoiceid ?? r.invoice_id) as string | number | undefined;
    if (id === undefined) return null;

    // FreshBooks soft-deletes invoices by setting vis_state = 1. Treat those
    // as if they were absent — they must not count toward the balance and
    // must be reconciled out of any local cache.
    const visState = Number(r.vis_state ?? 0);
    if (visState === 1) return null;

    // FreshBooks returns money as { amount: "12.50", code: "USD" } or as a string.
    const amount = readMoney(r.amount);
    const paid = readMoney(r.paid);
    const balance = readMoney(r.outstanding ?? r.balance);
    const currency =
      (typeof r.amount === 'object' && r.amount && 'code' in (r.amount as object)
        ? (r.amount as { code?: string }).code
        : (r.currency_code as string | undefined)) ?? 'USD';

    // If we can't even get the balance, the row is unusable — skip it but
    // signal upward by returning null. The caller already treats missing
    // invoices as ambiguous.
    if (!balance) return null;

    return {
      id: String(id),
      invoiceNumber: (r.invoice_number ?? r.number ?? null) as string | null,
      amount: amount ?? balance,
      paid: paid ?? toMoney(0)!,
      balance,
      currency,
      status: String(r.status ?? r.v3_status ?? 'unknown'),
      issuedDate: parseDate(r.create_date ?? r.created_at ?? r.date),
      dueDate: parseDate(r.due_date ?? r.dueDate ?? r.due_offset_days),
    };
  }
}

function readMoney(value: unknown): import('decimal.js').default | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value && 'amount' in (value as object)) {
    return toMoney((value as { amount: unknown }).amount);
  }
  return toMoney(value);
}

function parseDate(value: unknown): Date | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Sortable timestamp for an invoice row; 0 when no parseable date exists. */
function invoiceTime(i: Record<string, unknown>): number {
  const s = (i.create_date ?? i.created_at ?? i.date) as string | undefined;
  const t = s ? Date.parse(s) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export interface DeviceBilling {
  qty: number;
  hasInvoices: boolean;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
}

/**
 * Given the raw invoice rows for ONE client, find the latest non-deleted
 * invoice and sum the qty of every line named `RECONCILE_DEVICE_LINE_NAME`.
 * Pure (no network) so it can run over both a single-client fetch and rows
 * grouped out of a bulk account-wide fetch.
 */
function deviceBillingFromInvoiceRows(rows: Record<string, unknown>[]): DeviceBilling {
  const live = rows.filter((i) => Number(i.vis_state ?? 0) !== 1);
  if (live.length === 0) {
    return { qty: 0, hasInvoices: false, invoiceId: null, invoiceNumber: null, invoiceDate: null };
  }
  live.sort((a, b) => invoiceTime(b) - invoiceTime(a));
  const latest = live[0]!;
  const target = env.RECONCILE_DEVICE_LINE_NAME.trim().toLowerCase();
  const lines = (latest.lines ?? []) as Record<string, unknown>[];
  let qty = 0;
  for (const ln of lines) {
    if (String(ln.name ?? '').trim().toLowerCase() === target) {
      const n = Number(ln.qty ?? 0);
      if (Number.isFinite(n)) qty += n;
    }
  }
  return {
    qty,
    hasInvoices: true,
    invoiceId: String(latest.id ?? latest.invoiceid ?? ''),
    invoiceNumber: (latest.invoice_number ?? null) as string | null,
    invoiceDate: (latest.create_date ?? latest.created_at ?? latest.date ?? null) as
      | string
      | null,
  };
}

/** Extract the customer id off a raw invoice row, trying the known field names. */
export function invoiceCustomerId(inv: Record<string, unknown>): string | null {
  const id =
    (inv.customerid as string | number | undefined) ??
    (inv.userid as string | number | undefined) ??
    (inv.clientid as string | number | undefined) ??
    (inv.client_id as string | number | undefined);
  return id === undefined || id === null ? null : String(id);
}

// Singleton — one HTTP client across the process is intentional.
export const freshbooksService = new FreshBooksService();

// Re-export for convenient narrowing in callers.
export { TransientHttpError };
