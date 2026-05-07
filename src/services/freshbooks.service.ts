import { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  createHttpClient,
  PermanentHttpError,
  TransientHttpError,
} from '../utils/http';
import { toMoney } from '../utils/decimal';
import type { FreshbooksInvoice } from '../types';

const TOKEN_EXPIRED_HINT =
  'FreshBooks rejected the call with 401 — FRESHBOOKS_API_TOKEN is invalid or expired. ' +
  'Refresh it in FreshBooks → Developer settings, update backend/.env, then restart the server.';

function rewriteAuthError(err: unknown): unknown {
  const status = (err as { status?: number }).status;
  if (status === 401 || status === 403) {
    return new PermanentHttpError(TOKEN_EXPIRED_HINT, status);
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
        Authorization: `Bearer ${env.FRESHBOOKS_API_TOKEN}`,
        'Api-Version': 'alpha',
      },
    });
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
            include: 'lines,payments',
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

// Singleton — one HTTP client across the process is intentional.
export const freshbooksService = new FreshBooksService();

// Re-export for convenient narrowing in callers.
export { TransientHttpError };
