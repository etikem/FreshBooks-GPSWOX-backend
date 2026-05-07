import { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { createHttpClient } from '../utils/http';
import { prisma } from '../db/prisma';

/**
 * GPSWOX integration.
 *
 * Auth: GPSWOX uses a `user_api_hash` query parameter on every request,
 * obtained from POST /api/login (email + password). It is NOT a Bearer
 * token. We attach it via an axios request interceptor so callers don't
 * have to thread it through.
 *
 * Endpoints are env-driven. The default shape — PUT /api/admin/users/{id}
 * with {active, expiration_date} — is the standard admin endpoint across
 * GPSWOX installs. enable/disable/updateExpiration all hit this same URL
 * with different bodies, but the env vars stay split so a custom install
 * can route them differently without code changes.
 *
 * Idempotency: ActionLog.idempotencyKey dedupes audit rows for the same
 * logical operation (clientId + kind + canonical-payload). The HTTP call
 * itself is still re-sent on retry, because GPSWOX is the system of
 * record on the other side.
 */
export interface GpswoxAccessUpdate {
  enabled: boolean;
  accessExpiresAt?: string;
}

export class GpswoxService {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = createHttpClient({
      name: 'gpswox',
      baseURL: env.GPSWOX_API_BASE,
      timeoutMs: env.GPSWOX_HTTP_TIMEOUT_MS,
    });

    // Attach user_api_hash to every request as a query parameter.
    // Per GPSWOX docs this is how all authenticated calls work.
    this.http.interceptors.request.use((cfg) => {
      cfg.params = { ...(cfg.params ?? {}), user_api_hash: env.GPSWOX_USER_API_HASH };
      return cfg;
    });
  }

  // ── primitive endpoint helpers ─────────────────────────────────────
  private resolvePath(template: string, params: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      const v = params[key];
      if (v === undefined) {
        throw new Error(`gpswox: missing path param "${key}" for ${template}`);
      }
      return encodeURIComponent(v);
    });
  }

  /**
   * GPSWOX expects `expiration_date` as `YYYY-MM-DD HH:MM:SS` in server
   * local time, NOT ISO 8601. Format here so callers can keep handing us
   * `Date` objects without thinking about it.
   */
  private formatExpiration(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    );
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
   * Exchange email+password for a fresh user_api_hash. Use this once
   * out-of-band and put the result in GPSWOX_USER_API_HASH; we do not
   * call this on every request.
   */
  async login(email: string, password: string): Promise<string> {
    const res = await this.http.post<{ status: number; user_api_hash: string }>(
      env.GPSWOX_LOGIN_PATH,
      { email, password },
    );
    if (res.data?.status !== 1 || !res.data?.user_api_hash) {
      throw new Error(`gpswox login failed: ${JSON.stringify(res.data)}`);
    }
    return res.data.user_api_hash;
  }

  async enable(args: {
    clientId: string;
    gpswoxUserId: string;
    accessExpiresAt: Date;
  }): Promise<void> {
    const path = this.resolvePath(env.GPSWOX_ENDPOINT_ENABLE_DEVICES, {
      userId: args.gpswoxUserId,
    });
    const expiration_date = this.formatExpiration(args.accessExpiresAt);
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_ENABLE',
        payload: { gpswoxUserId: args.gpswoxUserId, expiration_date },
      },
      () =>
        this.http
          .put(path, { active: 1, expiration_date })
          .then(() => undefined),
    );
  }

  async disable(args: {
    clientId: string;
    gpswoxUserId: string;
  }): Promise<void> {
    const path = this.resolvePath(env.GPSWOX_ENDPOINT_DISABLE_DEVICES, {
      userId: args.gpswoxUserId,
    });
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_DISABLE',
        payload: { gpswoxUserId: args.gpswoxUserId },
      },
      () => this.http.put(path, { active: 0 }).then(() => undefined),
    );
  }

  async updateExpiration(args: {
    clientId: string;
    gpswoxUserId: string;
    accessExpiresAt: Date;
  }): Promise<void> {
    const path = this.resolvePath(env.GPSWOX_ENDPOINT_UPDATE_USER, {
      userId: args.gpswoxUserId,
    });
    const expiration_date = this.formatExpiration(args.accessExpiresAt);
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_UPDATE_EXPIRATION',
        payload: { gpswoxUserId: args.gpswoxUserId, expiration_date },
      },
      () =>
        this.http
          .put(path, { active: 1, expiration_date })
          .then(() => undefined),
    );
  }
}

export const gpswoxService = new GpswoxService();
