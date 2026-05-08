import { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { createHttpClient, PermanentHttpError } from '../utils/http';
import { prisma } from '../db/prisma';

/**
 * GPSWOX integration — admin client management.
 *
 * Auth:
 *   - All authenticated calls take a `user_api_hash` query parameter (NOT
 *     a Bearer token), obtained once via POST /api/login.
 *   - Admin endpoints additionally take a `lang` query parameter.
 *   Both are attached automatically by an axios request interceptor.
 *
 * Mapping of our domain ops to GPSWOX endpoints:
 *
 *   | op                | GPSWOX call                                                |
 *   |-------------------|------------------------------------------------------------|
 *   | enable            | PUT  /api/admin/client                                     |
 *   |                   |   { id, active: true, enable_expiration_date: true,        |
 *   |                   |     expiration_date }                                      |
 *   | disable           | POST /api/admin/client/status { id, status: false }        |
 *   | updateExpiration  | PUT  /api/admin/client (same as enable, retry path)        |
 *
 * Response handling:
 *   GPSWOX admin responses are JSON `{ "status": 1 }` on success. Anything
 *   else (status: 0, missing, error body) is treated as a permanent error
 *   so we don't loop on calls the server explicitly rejected.
 *
 * Idempotency:
 *   ActionLog.idempotencyKey dedupes audit rows for the same logical
 *   operation (clientId + kind + canonical-payload). The HTTP call itself
 *   is still re-sent on retry, because GPSWOX is the system of record.
 */
type AdminResponse = { status?: number; message?: string };

export class GpswoxService {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = createHttpClient({
      name: 'gpswox',
      baseURL: env.GPSWOX_API_BASE,
      timeoutMs: env.GPSWOX_HTTP_TIMEOUT_MS,
    });

    this.http.interceptors.request.use((cfg) => {
      cfg.params = {
        ...(cfg.params ?? {}),
        user_api_hash: env.GPSWOX_USER_API_HASH,
        lang: env.GPSWOX_LANG,
      };
      return cfg;
    });
  }

  // ── helpers ────────────────────────────────────────────────────────

  /**
   * GPSWOX expects `expiration_date` as `YYYY-MM-DD HH:MM:SS` in UTC,
   * NOT ISO 8601. Format here so callers can keep handing us `Date`.
   */
  private formatExpiration(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    );
  }

  /**
   * Coerce our string-typed gpswoxUserId into the integer `id` that
   * GPSWOX expects in admin client payloads. A non-numeric id is data
   * corruption, not a network blip — surface as permanent.
   */
  private toClientId(id: string): number {
    const n = Number.parseInt(id, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new PermanentHttpError(`invalid GPSWOX client id: ${id}`);
    }
    return n;
  }

  private assertOk(body: unknown, op: string): void {
    const r = body as AdminResponse;
    if (!r || r.status !== 1) {
      throw new PermanentHttpError(
        `gpswox ${op} returned non-ok status: ${JSON.stringify(body)}`,
      );
    }
  }

  // ── idempotency ────────────────────────────────────────────────────
  private idempotencyKey(input: {
    clientId: string;
    kind: string;
    payload: unknown;
  }): string {
    const canonical = JSON.stringify({
      clientId: input.clientId,
      kind: input.kind,
      payload: input.payload,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  private async withAudit<T>(
    args: {
      clientId: string;
      kind:
        | 'GPSWOX_ENABLE'
        | 'GPSWOX_DISABLE'
        | 'GPSWOX_UPDATE_EXPIRATION';
      payload: unknown;
      idempotencyKey?: string;
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = args.idempotencyKey ?? this.idempotencyKey(args);
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      await prisma.actionLog.create({
        data: {
          clientId: args.clientId,
          kind: 'ERROR',
          message: `${args.kind} failed`,
          details: {
            payload: args.payload as object,
            error: (err as Error).message,
          },
          idempotencyKey: null,
        },
      });
      throw err;
    }

    await prisma.actionLog
      .create({
        data: {
          clientId: args.clientId,
          kind: args.kind,
          message: `${args.kind} ok`,
          details: { payload: args.payload as object },
          idempotencyKey: key,
        },
      })
      .catch((e) => {
        logger.debug({ err: e?.message }, 'gpswox.audit.duplicate');
      });

    return result;
  }

  // ── public API ────────────────────────────────────────────────────

  /**
   * Exchange email+password for a fresh user_api_hash. Run once
   * out-of-band; persist the result in GPSWOX_USER_API_HASH.
   *
   * Per the docs the login endpoint expects multipart/form-data — JSON
   * is rejected. We send urlencoded (which servers accept identically)
   * to avoid pulling in a multipart library.
   */
  async login(email: string, password: string): Promise<string> {
    const form = new URLSearchParams();
    form.set('email', email);
    form.set('password', password);
    const res = await this.http.post<{ status: number; user_api_hash: string }>(
      env.GPSWOX_LOGIN_PATH,
      form,
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    );
    if (res.data?.status !== 1 || !res.data?.user_api_hash) {
      throw new Error(`gpswox login failed: ${JSON.stringify(res.data)}`);
    }
    return res.data.user_api_hash;
  }

  /**
   * Enable a client and set/extend their access expiration in one call.
   * PUT /api/admin/client { id, active: true, enable_expiration_date: true, expiration_date }
   */
  async enable(args: {
    clientId: string;
    gpswoxUserId: string;
    accessExpiresAt: Date;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    const expiration_date = this.formatExpiration(args.accessExpiresAt);
    const body = {
      id,
      active: true,
      enable_expiration_date: true,
      expiration_date,
    };
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_ENABLE',
        payload: body,
      },
      async () => {
        const res = await this.http.put(env.GPSWOX_ENDPOINT_CLIENT_UPDATE, body);
        this.assertOk(res.data, 'enable');
      },
    );
  }

  /**
   * Disable a client. Uses the dedicated status-toggle endpoint so we
   * don't have to send an entire client payload (which would risk
   * clobbering perms/email/etc. if the server treats PUT as a replace).
   * POST /api/admin/client/status { id, status: false }
   */
  async disable(args: {
    clientId: string;
    gpswoxUserId: string;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    const body = { id, status: false };
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_DISABLE',
        payload: body,
      },
      async () => {
        const res = await this.http.post(env.GPSWOX_ENDPOINT_CLIENT_STATUS, body);
        this.assertOk(res.data, 'disable');
      },
    );
  }

  /**
   * Extend a client's access without changing their enabled state.
   * Same endpoint as enable; kept as a separate operation so retries
   * are dispatched with intent-preserving names.
   */
  async updateExpiration(args: {
    clientId: string;
    gpswoxUserId: string;
    accessExpiresAt: Date;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    const expiration_date = this.formatExpiration(args.accessExpiresAt);
    const body = {
      id,
      active: true,
      enable_expiration_date: true,
      expiration_date,
    };
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_UPDATE_EXPIRATION',
        payload: body,
      },
      async () => {
        const res = await this.http.put(env.GPSWOX_ENDPOINT_CLIENT_UPDATE, body);
        this.assertOk(res.data, 'updateExpiration');
      },
    );
  }
}

export const gpswoxService = new GpswoxService();
