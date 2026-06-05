import { env } from '../config/env';
import { logger } from '../utils/logger';
import { abctrackService, type AbctrackClientRow } from './abctrack.service';
import { freshbooksService } from './freshbooks.service';

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
 * Classify a single active ABC Track client against FreshBooks:
 *   - no exact email match in FreshBooks → missing (enrich with form names)
 *   - matched but device counts differ   → mismatch
 *   - matched and counts equal           → none (nothing to surface)
 */
async function classify(row: AbctrackClientRow): Promise<Classified> {
  // A single email can map to more than one FreshBooks client (e.g. a personal
  // client + an organization). Pull every match and bill them together.
  const { clients } = await freshbooksService.findClientsByEmail(row.email);

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

  const freshbooksClientIds = clients.map((c) => String(c.id ?? c.userid ?? ''));
  const billing = await freshbooksService.getDeviceBillingForClients(freshbooksClientIds);

  // The ABC Track user (keyed by email) carries one device count; compare it to
  // the SUM of every FreshBooks client's billed quantity.
  if (billing.qty === row.devices_count) {
    return { kind: 'none' };
  }

  const byId = new Map(freshbooksClientIds.map((id, i) => [id, clients[i]!]));
  return {
    kind: 'mismatch',
    data: {
      abctrackId: row.id,
      freshbooksClientId: freshbooksClientIds.join(', '),
      freshbooksClientIds,
      email: row.email,
      name: clients.map(freshbooksName).filter(Boolean).join(' / ') || null,
      abctrackDevices: row.devices_count,
      freshbooksQty: billing.qty,
      hasInvoices: billing.hasInvoices,
      invoiceNumber: billing.invoiceNumber,
      invoiceDate: billing.invoiceDate,
      breakdown: billing.perClient.map((p) => ({
        freshbooksClientId: p.freshbooksClientId,
        name: freshbooksName(byId.get(p.freshbooksClientId) ?? {}),
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

  try {
    const rows = await abctrackService.listAllClients();
    const active = rows.filter((r) => r.active === 1 && r.email);

    const missing: MissingClient[] = [];
    const mismatch: VehicleMismatch[] = [];
    const rowErrors: Array<{ email: string; error: string }> = [];

    await mapLimit(active, env.RECONCILE_CONCURRENCY, async (row) => {
      try {
        const result = await classify(row);
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
    logger.info({ ...stats, durationMs: snapshot.durationMs }, 'reconcile.done');
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
