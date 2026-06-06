import { env } from '../config/env';
import { logger } from '../utils/logger';
import { abctrackService, type AbctrackClientRow } from './abctrack.service';
import { freshbooksService, invoiceCustomerId } from './freshbooks.service';

/**
 * Reconciliation sweep — diffs the ABC Track client population against
 * FreshBooks and surfaces two classes of discrepancy for an operator to act
 * on:
 *
 *   1. missingInFreshbooks — clients that are active in ABC Track but have no
 *      matching FreshBooks client (by email). The operator creates these on
 *      FreshBooks by hand; we hand them the name/email/phone to do it.
 *
 *   2. vehicleMismatch — clients present in BOTH systems whose ABC Track
 *      device count differs from the device quantity billed on their latest
 *      FreshBooks invoice.
 *
 * The full sweep touches the entire ABC Track roster (~hundreds of clients),
 * each requiring a FreshBooks lookup, so it can take a while. We run it in the
 * background and keep the latest result in memory; the admin API serves the
 * snapshot and can trigger a refresh. There is at most one sweep in flight at
 * a time (single-flight latch).
 */

export interface MissingClient {
  abctrackId: number;
  clientId: number | null;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
}

export interface VehicleMismatch {
  abctrackId: number;
  /**
   * The matched FreshBooks client id(s). When a single client matches this is
   * just its id; when several clients share the email it's a comma-joined list
   * and `freshbooksClientIds` / `breakdown` carry the per-client detail.
   */
  freshbooksClientId: string;
  freshbooksClientIds: string[];
  email: string;
  name: string | null;
  abctrackDevices: number;
  /** Summed device quantity across every FreshBooks client sharing the email. */
  freshbooksQty: number;
  hasInvoices: boolean;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  /**
   * Per-client device quantity — only interesting when more than one
   * FreshBooks client shares the email. Empty/single-element otherwise.
   */
  breakdown: Array<{
    freshbooksClientId: string;
    name: string | null;
    qty: number;
    invoiceNumber: string | null;
    invoiceDate: string | null;
  }>;
}

export interface ReconciliationSnapshot {
  status: 'idle' | 'running' | 'ready' | 'error';
  generatedAt: string | null;
  startedAt: string | null;
  durationMs: number | null;
  error: string | null;
  stats: {
    scanned: number;
    active: number;
    missing: number;
    mismatch: number;
    errors: number;
  } | null;
  missingInFreshbooks: MissingClient[];
  vehicleMismatch: VehicleMismatch[];
  rowErrors: Array<{ email: string; error: string }>;
}

const EMPTY: ReconciliationSnapshot = {
  status: 'idle',
  generatedAt: null,
  startedAt: null,
  durationMs: null,
  error: null,
  stats: null,
  missingInFreshbooks: [],
  vehicleMismatch: [],
  rowErrors: [],
};

let snapshot: ReconciliationSnapshot = EMPTY;
let running: Promise<void> | null = null;

export function getReconciliationSnapshot(): ReconciliationSnapshot {
  return snapshot;
}

/**
 * Kick off a sweep if one isn't already running, then return the current
 * snapshot (which will read `status: 'running'` once started). Idempotent —
 * calling it repeatedly while a sweep is in flight is a no-op.
 */
export function triggerReconciliation(): ReconciliationSnapshot {
  if (!running) {
    running = runSweep().finally(() => {
      running = null;
    });
  }
  return snapshot;
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Best-effort organization/name from a FreshBooks client record. */
function freshbooksName(client: Record<string, unknown>): string | null {
  const org = String(client.organization ?? '').trim();
  if (org) return org;
  const full = `${String(client.fname ?? '').trim()} ${String(client.lname ?? '').trim()}`.trim();
  return full || null;
}

type Classified =
  | { kind: 'missing'; data: MissingClient }
  | { kind: 'mismatch'; data: VehicleMismatch }
  | { kind: 'none' };

/**
 * Prefetched FreshBooks state, built once per sweep so classifying a row makes
 * ZERO FreshBooks calls. `clientsByEmail` maps a lowercased email to every
 * matching client (an email can map to several); `invoicesByCustomer` maps a
 * FreshBooks customer id to its invoice rows (lines included).
 */
interface SweepContext {
  clientsByEmail: Map<string, Record<string, unknown>[]>;
  invoicesByCustomer: Map<string, Record<string, unknown>[]>;
}

/**
 * Classify a single active ABC Track client against the prefetched FreshBooks
 * snapshot:
 *   - no exact email match in FreshBooks → missing (enrich with form names)
 *   - matched but device counts differ   → mismatch
 *   - matched and counts equal           → none (nothing to surface)
 */
async function classify(row: AbctrackClientRow, ctx: SweepContext): Promise<Classified> {
  // A single email can map to more than one FreshBooks client (e.g. a personal
  // client + an organization). Bill every match together.
  const clients = ctx.clientsByEmail.get(row.email.trim().toLowerCase()) ?? [];

  if (clients.length === 0) {
    let detail = null;
    try {
      detail = await abctrackService.getClientFormDetail(row.id);
    } catch (err) {
      // The names are a nicety; don't fail the whole row if the form 404s.
      logger.debug({ id: row.id, err: msg(err) }, 'reconcile.formDetail.failed');
    }
    return {
      kind: 'missing',
      data: {
        abctrackId: row.id,
        clientId: row.client_id,
        firstName: detail?.firstName ?? '',
        lastName: detail?.lastName ?? '',
        email: row.email,
        phoneNumber: detail?.phoneNumber || (row.phone_number ?? ''),
      },
    };
  }

  // Sum the billed device quantity across all matching clients, using the
  // prefetched invoice rows — no network here.
  const perClient = clients.map((c) => {
    const fbId = String(c.id ?? c.userid ?? '');
    const rows = ctx.invoicesByCustomer.get(fbId) ?? [];
    const b = freshbooksService.deviceBillingFromRows(rows);
    return {
      freshbooksClientId: fbId,
      name: freshbooksName(c),
      qty: b.qty,
      hasInvoices: b.hasInvoices,
      invoiceNumber: b.invoiceNumber,
      invoiceDate: b.invoiceDate,
    };
  });

  const freshbooksQty = perClient.reduce((sum, p) => sum + p.qty, 0);
  const hasInvoices = perClient.some((p) => p.hasInvoices);

  // The ABC Track user (keyed by email) carries one device count; compare it to
  // the SUM of every FreshBooks client's billed quantity.
  if (freshbooksQty === row.devices_count) {
    return { kind: 'none' };
  }

  // Representative invoice = most recent across all matched clients.
  const latest = perClient
    .filter((p) => p.invoiceDate)
    .sort((a, b) => Date.parse(b.invoiceDate!) - Date.parse(a.invoiceDate!))[0];

  return {
    kind: 'mismatch',
    data: {
      abctrackId: row.id,
      freshbooksClientId: perClient.map((p) => p.freshbooksClientId).join(', '),
      freshbooksClientIds: perClient.map((p) => p.freshbooksClientId),
      email: row.email,
      name: clients.map(freshbooksName).filter(Boolean).join(' / ') || null,
      abctrackDevices: row.devices_count,
      freshbooksQty,
      hasInvoices,
      invoiceNumber: latest?.invoiceNumber ?? null,
      invoiceDate: latest?.invoiceDate ?? null,
      breakdown: perClient.map((p) => ({
        freshbooksClientId: p.freshbooksClientId,
        name: p.name,
        qty: p.qty,
        invoiceNumber: p.invoiceNumber,
        invoiceDate: p.invoiceDate,
      })),
    },
  };
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function runSweep(): Promise<void> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  snapshot = { ...snapshot, status: 'running', startedAt, error: null };
  logger.info({ startedAt }, 'reconcile.start');

  // Baseline the cumulative FreshBooks counters so we can report this sweep's
  // own request/rate-limit totals as a delta.
  const fbBase = { ...freshbooksService.getRequestStats() };

  try {
    const rows = await abctrackService.listAllClients();
    const active = rows.filter((r) => r.active === 1 && r.email);

    // ── Prefetch the entire FreshBooks side ONCE (paginated) ─────────────
    // This replaces the previous two-calls-per-client pattern (one client
    // search + one invoice fetch per ABC Track row) that fanned out into
    // ~2×N requests and tripped the rate limit. We now make only a handful
    // of paginated calls total, then classify every row against in-memory
    // maps with zero further FreshBooks calls.
    const fbClients = await freshbooksService.listAllClients();
    const clientsByEmail = new Map<string, Record<string, unknown>[]>();
    for (const c of fbClients) {
      const email = String(c.email ?? '').trim().toLowerCase();
      if (!email) continue;
      const list = clientsByEmail.get(email);
      if (list) list.push(c);
      else clientsByEmail.set(email, [c]);
    }

    const fbInvoices = await freshbooksService.listAllInvoices({
      sinceDays: env.FRESHBOOKS_INVOICE_LOOKBACK_DAYS,
    });
    const invoicesByCustomer = new Map<string, Record<string, unknown>[]>();
    for (const inv of fbInvoices) {
      const cid = invoiceCustomerId(inv);
      if (!cid) continue;
      const list = invoicesByCustomer.get(cid);
      if (list) list.push(inv);
      else invoicesByCustomer.set(cid, [inv]);
    }

    const ctx: SweepContext = { clientsByEmail, invoicesByCustomer };
    logger.info(
      {
        fbClients: fbClients.length,
        fbInvoices: fbInvoices.length,
        invoiceLookbackDays: env.FRESHBOOKS_INVOICE_LOOKBACK_DAYS,
      },
      'reconcile.prefetched',
    );

    const missing: MissingClient[] = [];
    const mismatch: VehicleMismatch[] = [];
    const rowErrors: Array<{ email: string; error: string }> = [];

    await mapLimit(active, env.RECONCILE_CONCURRENCY, async (row) => {
      try {
        const result = await classify(row, ctx);
        if (result.kind === 'missing') missing.push(result.data);
        else if (result.kind === 'mismatch') mismatch.push(result.data);
      } catch (err) {
        rowErrors.push({ email: row.email || `id=${row.id}`, error: msg(err) });
        logger.warn({ email: row.email, err: msg(err) }, 'reconcile.row.failed');
      }
    });

    missing.sort((a, b) => a.email.localeCompare(b.email));
    mismatch.sort((a, b) => a.email.localeCompare(b.email));

    const stats = {
      scanned: rows.length,
      active: active.length,
      missing: missing.length,
      mismatch: mismatch.length,
      errors: rowErrors.length,
    };
    // FreshBooks request accounting for the whole sweep — total requests,
    // how many were rate-limited (429), and any that exhausted retries.
    const fbNow = freshbooksService.getRequestStats();
    const fb = {
      requests: fbNow.requests - fbBase.requests,
      rateLimitHits: fbNow.rateLimitHits - fbBase.rateLimitHits,
      retriesExhausted: fbNow.retriesExhausted - fbBase.retriesExhausted,
    };
    snapshot = {
      status: 'ready',
      generatedAt: new Date().toISOString(),
      startedAt,
      durationMs: Date.now() - startedAtMs,
      error: null,
      stats,
      missingInFreshbooks: missing,
      vehicleMismatch: mismatch,
      rowErrors,
    };
    logger.info(
      {
        ...stats,
        durationMs: snapshot.durationMs,
        freshbooksRequests: fb.requests,
        rateLimitHits: fb.rateLimitHits,
        retriesExhausted: fb.retriesExhausted,
      },
      'reconcile.done',
    );
  } catch (err) {
    snapshot = {
      ...snapshot,
      status: 'error',
      error: msg(err),
      durationMs: Date.now() - startedAtMs,
    };
    logger.error({ err: msg(err) }, 'reconcile.failed');
  }
}
