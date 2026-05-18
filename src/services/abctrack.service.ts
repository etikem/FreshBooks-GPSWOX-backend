import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { PermanentHttpError, TransientHttpError } from '../utils/http';
import { prisma } from '../db/prisma';
import { request as abctrackRequest, login as abctrackLogin } from './abctrack-session';

/**
 * AbctrackService is the ONLY layer that talks to live.abctrack.net.
 *
 * Naming note: the database keeps `Client.gpswoxUserId` and the action
 * kinds (`GPSWOX_ENABLE`, `GPSWOX_DISABLE`, `GPSWOX_UPDATE_EXPIRATION`,
 * `GPSWOX_MATCHED`, `NO_MATCHING_GPSWOX_USER`) intentionally — those are
 * stable internal constants and renaming them would force a noisy
 * cross-cutting migration with no functional benefit. The frontend
 * already labels them "ABC Track" for users.
 */

/** Trimmed view of an Abctrack admin client row — what we actually consume. */
export interface AbctrackClientSummary {
  id: number;
  email: string;
  active: number;
  /**
   * Display value, e.g. "04-05-2026 08:52:00 AM" — Abctrack returns it
   * formatted, not raw, so we don't try to parse it. Useful for diagnostics
   * but not for any decision logic.
   */
  subscription_expiration: string;
}

interface CacheEntry {
  value: AbctrackClientSummary | null;
  expiresAt: number;
}

/**
 * Shape of the table-payload list endpoint:
 *   GET /ui/payload/table/admin/client/client?search=&page=&...
 *
 * The response is triple-nested — `body.data.data.data[]` for the rows.
 * That's verbatim what Abctrack returns; the inner `data` object is the
 * Laravel paginator envelope (`current_page`, `last_page`, `data`, ...).
 */
interface AbctrackListEnvelope {
  data?: {
    data?: {
      data?: AbctrackClientSummary[];
      current_page?: number;
      last_page?: number;
      per_page?: number;
      total?: number;
    };
  };
}

class AbctrackService {
  private readonly emailCache = new Map<string, CacheEntry>();
  private readonly emailCacheMax = 1000;

  // ── cache plumbing (same shape as the previous service) ──────────
  private cacheGet(key: string): CacheEntry | null {
    const e = this.emailCache.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.emailCache.delete(key);
      return null;
    }
    return e;
  }
  private cacheSet(key: string, value: AbctrackClientSummary | null): void {
    if (this.emailCache.size >= this.emailCacheMax) {
      const first = this.emailCache.keys().next().value;
      if (first !== undefined) this.emailCache.delete(first);
    }
    const ttl = value
      ? env.ABCTRACK_EMAIL_CACHE_TTL_MS
      : env.ABCTRACK_EMAIL_NEG_CACHE_TTL_MS;
    this.emailCache.set(key, { value, expiresAt: Date.now() + ttl });
  }
  /** Test/admin hook — clears the email lookup cache. */
  clearEmailCache(): void {
    this.emailCache.clear();
  }

  // ── helpers ──────────────────────────────────────────────────────

  /**
   * Format a UTC Date as the `YYYY-MM-DD HH:MM` string Abctrack accepts
   * on the `expiration_date` form field. The example response shows the
   * server displaying it back as `DD-MM-YYYY hh:mm:ss AM/PM` so the
   * server clearly parses naive datetimes — we send the UTC wall-clock
   * value and document the assumption that Abctrack's server timezone
   * matches our business-rule timezone (UTC). If that ever stops being
   * true, this is the one function to fix.
   */
  private formatExpiration(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    );
  }

  /** Coerce string id → integer, surfacing data corruption as permanent. */
  private toClientId(id: string): number {
    const n = Number.parseInt(id, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new PermanentHttpError(`invalid Abctrack client id: ${id}`);
    }
    return n;
  }

  // ── audit + idempotency (mirrors the old service) ──────────────

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
        logger.debug({ err: e?.message }, 'abctrack.audit.duplicate');
      });

    return result;
  }

  // ── update plumbing ────────────────────────────────────────────

  /**
   * Fetch the current client record. We try GET on the same path used
   * for PUT/DELETE (Laravel REST convention); if that 404s we fall back
   * to the list endpoint with the id as `search`. Both shapes are
   * normalised to a flat object the update path can reuse.
   *
   * The returned object is fed back into the form on update, with our
   * fields overlaid. This honours the brief's "preserve all fields"
   * requirement — anything Abctrack returned, we return.
   */
  private async getClientRecord(id: number): Promise<Record<string, unknown> | null> {
    try {
      const res = await abctrackRequest<unknown>({
        method: 'GET',
        url: `${env.ABCTRACK_ENDPOINT_CLIENT_BASE}/${id}`,
      });
      const body = res.data as Record<string, unknown> | undefined;
      if (!body) return null;
      // Laravel often wraps a single resource as { data: { ... } } — peek through.
      const inner =
        (body as { data?: unknown }).data && typeof (body as { data?: unknown }).data === 'object'
          ? ((body as { data: Record<string, unknown> }).data as Record<string, unknown>)
          : body;
      return inner;
    } catch (err) {
      // If the dedicated GET isn't supported, fall back to the search.
      // We log once at warn so an operator can spot it but the integration
      // keeps working as long as the listing exists.
      if (err instanceof PermanentHttpError && err.status === 404) {
        logger.warn(
          { id },
          'abctrack.getClient.404 — falling back to search-by-id',
        );
        return this.getClientRecordViaSearch(id);
      }
      throw err;
    }
  }

  private async getClientRecordViaSearch(
    id: number,
  ): Promise<Record<string, unknown> | null> {
    const res = await abctrackRequest<AbctrackListEnvelope>({
      method: 'GET',
      url: env.ABCTRACK_ENDPOINT_CLIENT_LIST,
      params: {
        search: id,
        page: 1,
        sort: 'asc',
        sort_by: 'email',
        per_page: env.ABCTRACK_LIST_PER_PAGE,
      },
    });
    const rows = res.data?.data?.data?.data ?? [];
    const hit = rows.find((r) => Number(r.id) === id);
    return (hit as unknown as Record<string, unknown>) ?? null;
  }

  /**
   * Build a multipart FormData body for the update endpoint, with the
   * field set and insertion order taken verbatim from a captured admin-UI
   * UPDATE submission (POST /ui/admin/client/{id}, `_method=put` last).
   * Matching the form's exact shape matters here — sending the CREATE
   * field set, or sending `_method=put` first, returned 405 ("Whoops")
   * even when X-XSRF-TOKEN and the session cookie were good.
   *
   * Value priority for each form field is overrides → existing → default:
   *   - overrides: caller's intent (enable/disable flips `active`,
   *     updateExpiration sets `expiration_date`, syncProfile sets
   *     `email`/`phone_number`/`client[*]`). Always wins.
   *   - existing: the per-id GET response (or the listing-fallback
   *     summary if the dedicated GET 404'd). Round-tripped so we don't
   *     blank fields we never intended to touch — most importantly
   *     per-client `perms` and the device assignment (`selected_objects`
   *     / `objects`).
   *   - default: from CLIENT_CREATE_DEFAULTS, for the cases where
   *     `existing` is the listing-fallback summary that lacks
   *     group_id / available_maps / perms / etc.
   *
   * We send multipart/form-data (not x-www-form-urlencoded) because the
   * captured admin-UI curls confirm that's what the live server's
   * update validator expects — urlencoded posts trip a "field is
   * required" 422 for `email` / `available_maps` even when those keys
   * ARE in the body.
   */
  private buildUpdateBody(
    existing: Record<string, unknown>,
    overrides: Record<string, unknown>,
  ): FormData {
    // overrides → existing → fallback. Treats both undefined AND null
    // as "absent" so a null in the GET response doesn't blank a
    // required field via `appendField`'s null-to-empty-string mapping.
    const pick = (key: string, fallback: unknown): unknown => {
      if (overrides[key] !== undefined) return overrides[key];
      const e = existing[key];
      if (e !== undefined && e !== null) return e;
      return fallback;
    };

    const defaults = CLIENT_CREATE_DEFAULTS;
    const existingClient =
      existing.client && typeof existing.client === 'object' && !Array.isArray(existing.client)
        ? (existing.client as Record<string, unknown>)
        : {};
    const overridesClient =
      overrides.client && typeof overrides.client === 'object' && !Array.isArray(overrides.client)
        ? (overrides.client as Record<string, unknown>)
        : {};

    const fields: Record<string, unknown> = {
      active: pick('active', 1),
      email: pick('email', ''),
      phone_number: pick('phone_number', ''),
      group_id: pick('group_id', defaults.group_id),
      enable_manager_id: pick('enable_manager_id', defaults.enable_manager_id),
      available_maps: pick('available_maps', defaults.available_maps),
      enable_devices_limit: pick('enable_devices_limit', defaults.enable_devices_limit),
      enable_expiration_date: pick('enable_expiration_date', 0),
      expiration_date: pick('expiration_date', ''),
      // UPDATE-form-only fields. Hardcoded 0 because the admin UI sends
      // them as 0 on a plain save, and we never want a sync to trigger
      // a password reset or notification email.
      change_password: 0,
      send_account_password_changed_email: 0,
      perms: pick('perms', defaults.perms),
    };

    // Device assignments. Forward only if `existing` carries them —
    // sending empty arrays would unassign every device tied to this
    // client. The listing-fallback summary path doesn't include these,
    // so omitting on absence is the only safe choice.
    const selected = existing.selected_objects;
    if (Array.isArray(selected) && selected.length > 0) {
      fields.selected_objects = selected;
    }
    const objects = existing.objects;
    if (Array.isArray(objects) && objects.length > 0) {
      fields.objects = objects;
    }

    // Nested `client[*]`: defaults → existing → overrides so a partial
    // overlay (e.g. syncProfile setting first_name only) keeps unrelated
    // sub-fields like birth_date intact.
    fields.client = {
      ...(defaults.client as Record<string, unknown>),
      ...existingClient,
      ...overridesClient,
    };

    fields.edit_assigned_company = pick(
      'edit_assigned_company',
      defaults.edit_assigned_company,
    );
    fields.company_id = pick('company_id', defaults.company_id);

    // Table-view state. Reuse the CREATE-form constant — the server
    // tolerates unknown hashed column ids and the layout isn't part of
    // the per-client update.
    Object.assign(fields, ABCTRACK_CREATE_TABLE_STATE);

    // Method spoofing: actual HTTP verb stays POST (`fetchAndUpdate`
    // sends POST), `_method=put` last flips it to PUT server-side.
    // Position matches the captured form exactly.
    fields._method = 'put';

    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      this.appendField(body, key, value);
    }
    return body;
  }

  /**
   * PHP-style key flattening for nested objects/arrays. Mirrors the
   * `name="perms[devices][view]"` and `name="available_maps[]"` shape
   * Abctrack expects. We walk objects recursively.
   *
   * Works against any container that exposes the standard
   * `.append(key, value)` form-body API (URLSearchParams or FormData).
   *
   * Skips a small set of fields that are configuration/UI artefacts on
   * the listing response and aren't valid update inputs (sending them
   * back can confuse the server's validator).
   */
  private appendField(
    body: URLSearchParams | FormData,
    key: string,
    value: unknown,
  ): void {
    // Drop fields that exist on the listing payload but aren't part of
    // the editable form — these get stripped at update time.
    const SKIP = new Set([
      'config',
      'created_at',
      'updated_at',
      'loged_at',
      'email_verified_at',
      'phone_verified_at',
      'sms_gateway_app_date',
      'sms_gateway_params',
      'subscription_expiration', // display-only mirror of expiration_date
      'devices_count',
      'subusers_count',
      'role_id',
      // company_id is intentionally NOT skipped — we set it from
      // CLIENT_CREATE_DEFAULTS so the update endpoint accepts the form.
      'manager.email',
      'manager',
      'billing_plan',
      'api_hash_expire',
      'login_periods',
      'top_toolbar_open',
      'map_controls',
      'ungrouped_open',
      'settings',
      'links',
    ]);
    if (SKIP.has(key)) return;

    if (value === null) {
      body.append(key, '');
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        body.append(`${key}[]`, item == null ? '' : String(item));
      }
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        this.appendField(body, `${key}[${k}]`, v);
      }
      return;
    }
    body.append(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }

  /**
   * Fetch-then-PUT helper. Centralises the read-modify-write pattern so
   * `enable`, `disable`, and `updateExpiration` all share one code path.
   *
   * The body is sent as multipart/form-data. We deliberately do NOT set
   * a Content-Type header here — when axios sees a FormData instance as
   * `data` it generates a boundary and sets the matching
   * `Content-Type: multipart/form-data; boundary=...` itself. Overriding
   * it would corrupt the body framing.
   */
  private async fetchAndUpdate(args: {
    id: number;
    overrides: Record<string, unknown>;
  }): Promise<void> {
    const existing = await this.getClientRecord(args.id);
    if (!existing) {
      throw new PermanentHttpError(
        `abctrack client id=${args.id} not found — cannot update`,
        404,
      );
    }
    const body = this.buildUpdateBody(existing, args.overrides);
    await abctrackRequest({
      method: 'POST',
      url: `${env.ABCTRACK_ENDPOINT_CLIENT_BASE}/${args.id}`,
      data: body,
      // The admin UI sends a `form: true` header on every write. Some
      // server-side middleware appears to gate method spoofing on it:
      // without this header the same POST + `_method=put` body 405s
      // with a generic "Whoops" envelope.
      headers: { form: 'true' },
    });
  }

  // ── public API ────

  /**
   * Manual login. Normally we lazy-login on first request, but exposing
   * an explicit method keeps the surface compatible with anything that
   * wants to validate credentials at boot.
   */
  async login(_email?: string, _password?: string): Promise<void> {
    // Credentials come from env — args ignored, kept for shape parity.
    await abctrackLogin();
  }

  /**
   * Enable a client and (optionally) set their access expiration.
   * Maps to `PUT /ui/admin/client/{id}` with active=1.
   *
   * `accessExpiresAt`:
   *   - Date  → send `enable_expiration_date=1` + formatted `expiration_date`.
   *   - null  → ONLY override `active=1`. Do NOT touch
   *             `enable_expiration_date` or `expiration_date` — the
   *             fetch-then-update round-trip preserves whatever the
   *             operator has set manually in ABC Track. Used for
   *             unlimited accounts: our system bypasses billing entirely
   *             and the operator owns the expiration field on their end.
   */
  async enable(args: {
    clientId: string;
    gpswoxUserId: string;
    accessExpiresAt: Date | null;
    /**
     * The DB-side email. Threaded in because the per-id GET doesn't always
     * surface a usable `email` on the existing record (response is wrapped
     * in a `data` envelope that varies by Abctrack release), and the
     * server's update validator requires it. Passing it here guarantees
     * `buildUpdateBody`'s `pick('email')` finds a value via overrides
     * regardless of what GET returned.
     */
    email?: string | null;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    const overrides: Record<string, unknown> =
      args.accessExpiresAt === null
        ? {
            // Unlimited path: only enforce active=1. Leave
            // enable_expiration_date and expiration_date untouched so the
            // operator's manual settings in ABC Track survive our update.
            active: 1,
          }
        : {
            active: 1,
            enable_expiration_date: 1,
            expiration_date: this.formatExpiration(args.accessExpiresAt),
          };
    if (args.email) overrides.email = args.email;
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_ENABLE',
        payload: { id, ...overrides },
      },
      async () => {
        await this.fetchAndUpdate({ id, overrides });
      },
    );
  }

  /**
   * Hard-deactivate a client (active=0). Only used when the FreshBooks
   * client record is deleted — the account is kept in ABC Track but fully
   * deactivated. For non-paying clients use `disable()` instead, which
   * blocks via expiration_date and leaves active untouched.
   */
  async deactivate(args: {
    clientId: string;
    gpswoxUserId: string;
    email?: string | null;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    const overrides: Record<string, unknown> = { active: 0 };
    if (args.email) overrides.email = args.email;
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_DISABLE',
        payload: { id, ...overrides },
      },
      async () => {
        await this.fetchAndUpdate({ id, overrides });
      },
    );
  }

  /**
   * Block a client by setting their expiration_date to now. We never set
   * active=0 — the expiration date alone is sufficient to prevent login,
   * and flipping active causes confusion when operators inspect accounts.
   * When the client pays again, `enable` will set a future expiration_date.
   */
  async disable(args: {
    clientId: string;
    gpswoxUserId: string;
    /** See `enable` — the update validator requires email. */
    email?: string | null;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    const overrides: Record<string, unknown> = {
      active: 1,
      enable_expiration_date: 1,
      expiration_date: this.formatExpiration(new Date()),
    };
    if (args.email) overrides.email = args.email;
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_DISABLE',
        payload: { id, ...overrides },
      },
      async () => {
        await this.fetchAndUpdate({ id, overrides });
      },
    );
  }

  /**
   * Push the FreshBooks-side profile onto the existing abctrack record so
   * `client.update` / `invoice.*` / `payment.*` webhooks keep the GPS
   * account aligned with whatever the operator just changed in
   * FreshBooks. Mirrors the field set the manual admin UI sends on its
   * "save client" form, including the nested `client[*]` block so the
   * FreshBooks id is stamped onto `client[personal_code]` (cross-system
   * linkage beyond the email match).
   *
   * Does NOT flip `active` or `expiration_date` — `enable` / `disable` /
   * `updateExpiration` own those.
   */
  async syncProfile(args: {
    clientId: string;
    gpswoxUserId: string;
    email: string;
    phoneNumber: string | null;
    firstName?: string | null;
    lastName?: string | null;
    address?: string | null;
    notes?: string | null;
    /** FreshBooks client id — stored as `client[personal_code]` on the abctrack row. */
    personalCode?: string | null;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    const overrides: Record<string, unknown> = {
      email: args.email,
      phone_number: args.phoneNumber ?? '',
      // Nested `client[*]` block. Spread keeps any defaults that would
      // otherwise be empty strings, then we overlay the fields we actually
      // have from FreshBooks.
      client: {
        ...(CLIENT_CREATE_DEFAULTS.client as Record<string, unknown>),
        first_name: args.firstName ?? '',
        last_name: args.lastName ?? '',
        address: args.address ?? '',
        comment: args.notes ?? '',
        personal_code: args.personalCode ? `AT-${args.personalCode}` : '',
      },
    };
    await this.fetchAndUpdate({ id, overrides });
    logger.info(
      {
        id,
        clientId: args.clientId,
        email: args.email,
        phoneNumber: args.phoneNumber,
        personalCode: args.personalCode,
      },
      'abctrack.profile.synced',
    );
  }

  /**
   * Extend expiration without touching `active`. Useful when a payment
   * arrives for a still-active client. Pass `accessExpiresAt: null` to
   * leave the operator-set expiration alone (no-op write, used only for
   * symmetry with `enable`).
   */
  async updateExpiration(args: {
    clientId: string;
    gpswoxUserId: string;
    accessExpiresAt: Date | null;
    /** See `enable` — the update validator requires email. */
    email?: string | null;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    if (args.accessExpiresAt === null) {
      // No-op: there's nothing to push when the caller doesn't have a
      // date to assert. Operator-managed expirations on unlimited
      // accounts are owned by the ABC Track admin UI, not us.
      return;
    }
    const overrides: Record<string, unknown> = {
      enable_expiration_date: 1,
      expiration_date: this.formatExpiration(args.accessExpiresAt),
    };
    if (args.email) overrides.email = args.email;
    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_UPDATE_EXPIRATION',
        payload: { id, ...overrides },
      },
      async () => {
        await this.fetchAndUpdate({ id, overrides });
      },
    );
  }

  /**
   * Look up a user by email. Abctrack's listing accepts `search=`, which
   * matches against several columns server-side, so we pass the email
   * there to narrow the page count, then verify locally for an exact
   * (case-insensitive) email match.
   */
  async findUserByEmail(email: string): Promise<AbctrackClientSummary | null> {
    const norm = email.trim().toLowerCase();
    if (!norm) return null;

    const cached = this.cacheGet(norm);
    if (cached) return cached.value;

    const perPage = env.ABCTRACK_LIST_PER_PAGE;
    const maxPages = env.ABCTRACK_LIST_MAX_PAGES;
    let page = 1;
    let firstHit: AbctrackClientSummary | null = null;
    let extraHits = 0;
    let scanned = 0;

    while (page <= maxPages) {
      const res = await abctrackRequest<AbctrackListEnvelope>({
        method: 'GET',
        url: env.ABCTRACK_ENDPOINT_CLIENT_LIST,
        params: {
          search: norm,
          page,
          sort: 'asc',
          sort_by: 'email',
          per_page: perPage,
        },
      });
      // Abctrack envelope: { data: { data: { data: [...], last_page, ... } } }
      const inner = res.data?.data?.data;
      const rows = Array.isArray(inner?.data) ? inner!.data : [];
      scanned += rows.length;

      for (const row of rows) {
        const rowEmail = (row?.email ?? '').toString().trim().toLowerCase();
        if (!rowEmail) continue;
        if (rowEmail === norm) {
          if (!firstHit) firstHit = row;
          else extraHits += 1;
        }
      }

      const lastPage = Number(inner?.last_page ?? page);
      if (page >= lastPage || rows.length === 0) break;
      page += 1;
    }

    if (page > maxPages) {
      logger.warn(
        { email: norm, maxPages, perPage, scanned },
        'abctrack.findByEmail.page-cap-reached',
      );
    }
    if (firstHit && extraHits > 0) {
      logger.warn(
        { email: norm, extraHits, picked: firstHit.id },
        'abctrack.findByEmail.duplicate-emails',
      );
    }

    this.cacheSet(norm, firstHit);
    logger.info(
      { email: norm, hit: !!firstHit, scanned, pages: page },
      'abctrack.findByEmail.done',
    );
    return firstHit;
  }

  /**
   * Create an Abctrack client whose email matches a FreshBooks client we
   * couldn't auto-map. Mirrors the admin UI's "create client" form
   * (POST /ui/admin/client) — the static defaults below were captured
   * from a real session so we get the same group/permissions/maps that an
   * operator would set manually.
   *
   * The create response doesn't include the new id, so we re-look-up by
   * email afterwards to retrieve it. The email cache is busted first.
   *
   * Returns the new Abctrack client id.
   */
  async createUser(args: {
    clientId: string;
    email: string;
    phoneNumber: string | null;
    firstName?: string | null;
    lastName?: string | null;
    address?: string | null;
    /**
     * FreshBooks client id — stamped onto `client[personal_code]` with
     * an `AT-` prefix (e.g. FreshBooks `206` → `AT-206`). Per-client
     * requirement: keeps the FreshBooks↔ABC Track linkage visible in
     * the ABC Track admin UI's ID field.
     */
    personalCode?: string | null;
    /**
     * Expiration to seed on the new row.
     *   - Date  → enable_expiration_date=1, formatted date
     *   - null  → enable_expiration_date=0, empty. Used when no payment
     *             has been received yet, or when the client is being
     *             created as unlimited (the operator can set their own
     *             expiration in ABC Track later; subsequent enable calls
     *             will leave it alone — see `enable`).
     */
    accessExpiresAt: Date | null;
  }): Promise<number> {
    // Field insertion order mirrors the captured admin-UI submission to
    // POST /ui/admin/client byte-for-byte (modulo boundary). User-supplied
    // values are interleaved at the positions the admin form uses; defaults
    // come from CLIENT_CREATE_DEFAULTS, the trailing table-state block from
    // ABCTRACK_CREATE_TABLE_STATE. Object literals iterate in insertion
    // order, and appendField walks them in iteration order — so the wire
    // body matches the captured form's field sequence.
    const active = 1;
    const expirationEnabled = args.accessExpiresAt === null ? 0 : 1;
    const expirationDate =
      args.accessExpiresAt === null ? '' : this.formatExpiration(args.accessExpiresAt);
    const fields: Record<string, unknown> = {
      active,
      email: args.email,
      phone_number: args.phoneNumber ?? '',
      group_id: CLIENT_CREATE_DEFAULTS.group_id,
      enable_manager_id: CLIENT_CREATE_DEFAULTS.enable_manager_id,
      available_maps: CLIENT_CREATE_DEFAULTS.available_maps,
      enable_devices_limit: CLIENT_CREATE_DEFAULTS.enable_devices_limit,
      enable_expiration_date: expirationEnabled,
      expiration_date: expirationDate,
      password_generate: CLIENT_CREATE_DEFAULTS.password_generate,
      account_created: CLIENT_CREATE_DEFAULTS.account_created,
      perms: CLIENT_CREATE_DEFAULTS.perms,
      client: {
        ...(CLIENT_CREATE_DEFAULTS.client as Record<string, unknown>),
        first_name: args.firstName ?? '',
        last_name: args.lastName ?? '',
        address: args.address ?? '',
        personal_code: args.personalCode ? `AT-${args.personalCode}` : '',
      },
      edit_assigned_company: CLIENT_CREATE_DEFAULTS.edit_assigned_company,
      ...ABCTRACK_CREATE_TABLE_STATE,
      _method: 'post',
    };

    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      this.appendField(body, key, value);
    }

    try {
      // multipart/form-data — axios sets the boundary itself when it sees
      // a FormData instance. The captured admin-UI curls confirm the
      // server's create validator parses this content type. `form: true`
      // mirrors the header the admin UI attaches to every write request.
      await abctrackRequest({
        method: 'POST',
        url: env.ABCTRACK_ENDPOINT_CLIENT_BASE,
        data: body,
        headers: { form: 'true' },
      });
    } catch (err) {
      await prisma.actionLog.create({
        data: {
          clientId: args.clientId,
          kind: 'ERROR',
          message: `abctrack.createUser failed: ${(err as Error).message}`,
          details: { email: args.email },
        },
      });
      throw err;
    }

    // Bust the negative cache and look the new row up by email — Abctrack
    // doesn't return the id on the create response.
    this.clearEmailCache();
    const created = await this.findUserByEmail(args.email);
    if (!created) {
      throw new PermanentHttpError(
        `Created Abctrack user for ${args.email}, but follow-up lookup did not return the row.`,
      );
    }
    logger.info(
      { id: created.id, email: args.email, clientId: args.clientId },
      'abctrack.user.created',
    );
    return created.id;
  }

  /**
   * Hard-delete an Abctrack client. Mirrors the bulk-delete pattern from
   * Abctrack's own UI: actual HTTP method is DELETE, body carries
   * `_method=delete` so Laravel parses it the same way regardless of
   * proxy/buffering.
   */
  async deleteUser(args: {
    clientId: string;
    gpswoxUserId: string;
  }): Promise<void> {
    const id = this.toClientId(args.gpswoxUserId);
    const body = new URLSearchParams();
    body.set('_method', 'delete');

    await this.withAudit(
      {
        clientId: args.clientId,
        kind: 'GPSWOX_DISABLE',
        payload: { id, op: 'delete' },
      },
      async () => {
        await abctrackRequest({
          method: 'DELETE',
          url: `${env.ABCTRACK_ENDPOINT_CLIENT_BASE}/${id}`,
          data: body.toString(),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
      },
    );
  }
}

// Singleton — one cookie jar / one cache across the process is intentional.
export const abctrackService = new AbctrackService();

// Re-export so callers can narrow on TransientHttpError without an extra import.
export { TransientHttpError };

/**
 * Static defaults for the "create client" form (POST /ui/admin/client).
 * Captured verbatim from a real admin session so the new user lands with
 * the same group, available maps, and permission set an operator would
 * pick by hand. User-specific fields (email, phone_number, first/last
 * name, address, expiration_date) are layered on top by `createUser`.
 */
const CLIENT_CREATE_DEFAULTS: Record<string, unknown> = {
  group_id: 2,
  enable_manager_id: 0,
  available_maps: [4, 3, 1, 5, 25, 22, 23, 24, 2, 6],
  enable_devices_limit: 0,
  password_generate: 1,
  account_created: 0,
  // Update-time fields. The admin form always carries them (defaulted to
  // 0 for an unchanged save). Adding them here keeps the create call and
  // every subsequent fetch-then-update aligned with what the manual UI
  // sends.
  change_password: 0,
  send_account_password_changed_email: 0,
  edit_assigned_company: 1,
  // Tenant assignment. Captured from the live operator's session — change
  // here if you ever run multiple ABC Track companies from one backend.
  company_id: 3,
  perms: {
    devices: { view: 1, edit: 0, remove: 0 },
    alerts: { view: 0, edit: 0, remove: 0 },
    events: { view: 1, edit: 0, remove: 1 },
    geofences: { view: 1, edit: 1, remove: 1 },
    routes: { view: 1, edit: 1, remove: 1 },
    poi: { view: 1, edit: 1, remove: 1 },
    reports: { view: 1, edit: 1, remove: 1 },
    drivers: { view: 1, edit: 1, remove: 1 },
    custom_events: { view: 1, edit: 1, remove: 1 },
    user_gprs_templates: { view: 1, edit: 1, remove: 1 },
    user_sms_templates: { view: 1, edit: 1, remove: 1 },
    global_gprs_templates: { view: 1, edit: 0, remove: 0 },
    global_sms_templates: { view: 1, edit: 0, remove: 0 },
    sms_gateway: { view: 0, edit: 0, remove: 0 },
    send_command: { view: 1, edit: 1, remove: 0 },
    history: { view: 1, edit: 0, remove: 1 },
    maintenance: { view: 1, edit: 0, remove: 0 },
    camera: { view: 0, edit: 0, remove: 0 },
    device_camera: { view: 0, edit: 0, remove: 0 },
    tasks: { view: 1, edit: 1, remove: 1 },
    task_sets: { view: 1, edit: 1, remove: 1 },
    chat: { view: 0, edit: 0, remove: 0 },
    sharing: { view: 1, edit: 1, remove: 1 },
    device_configuration: { view: 0, edit: 0, remove: 0 },
    device_route_types: { view: 0, edit: 0, remove: 0 },
    device_expenses: { view: 1, edit: 1, remove: 1 },
    users: { view: 1, edit: 1, remove: 1 },
    // Field-level perms keyed by `device.<col>` / `user.<col>`. The dot is
    // part of the literal key name — appendField writes them as
    // perms[device.name][view] etc., which is what Abctrack expects.
    'device.name': { view: 0, edit: 1, remove: 0 },
    'device.imei': { view: 0, edit: 0, remove: 0 },
    'device.sim_number': { view: 0, edit: 0, remove: 0 },
    'device.forward': { view: 0, edit: 0, remove: 0 },
    'device.protocol': { view: 0, edit: 0, remove: 0 },
    'device.expiration_date': { view: 0, edit: 0, remove: 0 },
    'device.installation_date': { view: 1, edit: 0, remove: 0 },
    'device.sim_activation_date': { view: 0, edit: 0, remove: 0 },
    'device.sim_expiration_date': { view: 0, edit: 0, remove: 0 },
    'device.device_model': { view: 1, edit: 1, remove: 0 },
    'device.plate_number': { view: 1, edit: 1, remove: 0 },
    'device.registration_number': { view: 1, edit: 1, remove: 0 },
    'device.object_owner': { view: 1, edit: 1, remove: 0 },
    'device.vin': { view: 1, edit: 1, remove: 0 },
    'device.additional_notes': { view: 1, edit: 1, remove: 0 },
    'device.comment': { view: 1, edit: 1, remove: 0 },
    'device.max_speed': { view: 0, edit: 0, remove: 0 },
    'user.client_id': { view: 1, edit: 1, remove: 0 },
  },
  client: {
    first_name: '',
    last_name: '',
    personal_code: '',
    birth_date: '',
    address: '',
    comment: '',
  },
};

/**
 * Static table-view state the admin UI page emits with every CREATE
 * submission. Describes the admin's saved client-list layout, not the
 * user being created — the server appears to treat this as the
 * logged-in operator's UI preferences (sort column, visible columns,
 * column order). Captured verbatim from a real session so the wire
 * body matches the frontend byte-for-byte.
 *
 * The `columns[<32-hex>]` entries are admin-UI custom column ids tied
 * to the originator's account; they are not meaningful to other admins
 * but the server tolerates unknown ids and we keep them so the payload
 * matches what the browser sent. Not used in UPDATE.
 */
const ABCTRACK_CREATE_TABLE_STATE: Record<string, unknown> = {
  sort: { column: 'name', direction: 'asc' },
  columns: {
    active: { visible: 1, order: 0 },
    name: { visible: 1, order: 1 },
    imei: { visible: 1, order: 2 },
    status: { visible: 1, order: 3 },
    expiration_date: { visible: 1, order: 4 },
    users_list: { visible: 1, order: 5 },
    'traccar.server_time': { visible: 1, order: 6 },
    id: { visible: 0, order: 7 },
    position: { visible: 0, order: 8 },
    speed: { visible: 0, order: 9 },
    'traccar.protocol': { visible: 0, order: 10 },
    device_model: { visible: 0, order: 11 },
    plate_number: { visible: 0, order: 12 },
    vin: { visible: 0, order: 13 },
    registration_number: { visible: 0, order: 14 },
    object_owner: { visible: 0, order: 15 },
    additional_notes: { visible: 0, order: 16 },
    sim_number: { visible: 0, order: 17 },
    sim_activation_date: { visible: 0, order: 18 },
    sim_expiration_date: { visible: 0, order: 19 },
    installation_date: { visible: 0, order: 20 },
    distance: { visible: 0, order: 21 },
    idle_duration: { visible: 0, order: 22 },
    ignition_duration: { visible: 0, order: 23 },
    fuel_percentage: { visible: 0, order: 24 },
    fuel_quantity: { visible: 0, order: 25 },
    fuel_price: { visible: 0, order: 26 },
    stop_duration: { visible: 0, order: 27 },
    'group.title': { visible: 0, order: 28 },
    'last_event.title': { visible: 0, order: 29 },
    'last_event.time': { visible: 0, order: 30 },
    'last_event.type': { visible: 0, order: 31 },
    address: { visible: 0, order: 32 },
    created_at: { visible: 0, order: 33 },
    d02bf20e3aac3f452f78e8a918e3f85a: { visible: 0, order: 34 },
    '7cce2dfb89608daf97dde67327099851': { visible: 0, order: 35 },
    '37d255646c9eb5abb190b109e3a73e2a': { visible: 0, order: 36 },
    e62220aba9049936e189d7e4aa99ce5e: { visible: 0, order: 37 },
    ba5fb604c2d156e87af9d847d95e9ed0: { visible: 0, order: 38 },
    fa649329284a574cd4897bb6fd5f2b04: { visible: 0, order: 39 },
    '519585c39beb2c1ed3b18ec15d2ef9a6': { visible: 0, order: 40 },
    c4e25b4274390229bd75098feacc3b81: { visible: 0, order: 41 },
    db1c2a53d23bb924842fc4ea7c7c86c0: { visible: 0, order: 42 },
    '7e5d719c6be6ffadbe76ddc81cef13e8': { visible: 0, order: 43 },
    '1e56fdf4776815472f3639acf07a3e4f': { visible: 0, order: 44 },
    '964a4e8f4e6c4ba1db659385189504ca': { visible: 0, order: 45 },
    '17fae2bfa05c604c07ab1516811efa64': { visible: 0, order: 46 },
    '125add4cc62d1b40e564e6214a9c6d5e': { visible: 0, order: 47 },
    '53f71e46fb2e03be2f5127544d4fc986': { visible: 0, order: 48 },
    '3e17e14202607886c4ca7fe31a71df5b': { visible: 0, order: 49 },
    ff9e70a772b277448ecb23d7519c8906: { visible: 0, order: 50 },
    b43af8730dea96a9ae1a091c5c0581c9: { visible: 0, order: 51 },
    c782f4a1975ce52ac3a11aba450c04a0: { visible: 0, order: 52 },
    a20906491f8ec38e4b0ba9bff226d3fc: { visible: 0, order: 53 },
  },
  table_name: 'table-object-object',
  report_types_config: 0,
};
