import { describe, it, expect, beforeEach, vi } from 'vitest';
import { abctrackService, AbctrackClientSummary } from '../src/services/abctrack.service';
import * as session from '../src/services/abctrack-session';

/**
 * Abctrack has no native search-by-email endpoint, so findUserByEmail
 * paginates `/ui/payload/table/admin/client/client?search=...` and matches
 * locally. We verify:
 *   1. happy path on page 1
 *   2. happy path requiring multiple pages
 *   3. miss returns null
 *   4. cache hit avoids extra HTTP calls
 *   5. case-insensitive match
 *
 * The session-layer `request()` is stubbed via vi.spyOn so the service
 * never actually hits the network or attempts a login.
 */
function pageEnvelope(rows: Partial<AbctrackClientSummary>[], lastPage: number) {
  // Triple-nested envelope verbatim — body.data.data.data is the rows array.
  return {
    data: {
      data: {
        data: rows.map((r) => ({
          id: r.id ?? 0,
          email: r.email ?? '',
          active: r.active ?? 1,
          subscription_expiration: r.subscription_expiration ?? '0000-00-00 00:00:00',
        })),
        last_page: lastPage,
        current_page: 1,
        per_page: 20,
        total: rows.length,
      },
    },
  };
}

function stubRequest(responsesByPage: Record<number, ReturnType<typeof pageEnvelope>>) {
  const spy = vi
    .spyOn(session, 'request')
    .mockImplementation(async (opts: { params?: { page?: number } }) => {
      const page = opts.params?.page ?? 1;
      const body = responsesByPage[page];
      if (!body) throw new Error(`unexpected page=${page}`);
      // Return a minimal AxiosResponse-ish shape — service only reads .data.
      return { data: body, status: 200, statusText: 'OK', headers: {}, config: {} } as never;
    });
  return spy;
}

describe('abctrackService.findUserByEmail', () => {
  beforeEach(() => {
    abctrackService.clearEmailCache();
    vi.restoreAllMocks();
  });

  it('returns the matching user when it lives on page 1', async () => {
    const spy = stubRequest({
      1: pageEnvelope(
        [
          { id: 7, email: 'alice@example.com' },
          { id: 8, email: 'bob@example.com' },
        ],
        1,
      ),
    });
    const hit = await abctrackService.findUserByEmail('alice@example.com');
    expect(hit?.id).toBe(7);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('paginates until the email is found', async () => {
    const spy = stubRequest({
      1: pageEnvelope([{ id: 1, email: 'a@x.com' }], 3),
      2: pageEnvelope([{ id: 2, email: 'b@x.com' }], 3),
      3: pageEnvelope([{ id: 42, email: 'target@example.com' }], 3),
    });
    const hit = await abctrackService.findUserByEmail('target@example.com');
    expect(hit?.id).toBe(42);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('returns null when the email is not present', async () => {
    stubRequest({
      1: pageEnvelope(
        [
          { id: 1, email: 'a@x.com' },
          { id: 2, email: 'b@x.com' },
        ],
        2,
      ),
      2: pageEnvelope([{ id: 3, email: 'c@x.com' }], 2),
    });
    const hit = await abctrackService.findUserByEmail('nobody@example.com');
    expect(hit).toBeNull();
  });

  it('matches case-insensitively and trims whitespace', async () => {
    stubRequest({
      1: pageEnvelope([{ id: 9, email: 'CaseTest@Example.COM' }], 1),
    });
    const hit = await abctrackService.findUserByEmail('  caseTEST@example.com  ');
    expect(hit?.id).toBe(9);
  });

  it('caches a positive lookup so a repeat does not hit HTTP', async () => {
    const spy = stubRequest({
      1: pageEnvelope([{ id: 5, email: 'cached@example.com' }], 1),
    });
    await abctrackService.findUserByEmail('cached@example.com');
    await abctrackService.findUserByEmail('cached@example.com');
    await abctrackService.findUserByEmail('CACHED@example.com');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caches a negative lookup', async () => {
    const spy = stubRequest({
      1: pageEnvelope([{ id: 1, email: 'someone@x.com' }], 1),
    });
    await abctrackService.findUserByEmail('miss@example.com');
    await abctrackService.findUserByEmail('miss@example.com');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('skips rows with empty email gracefully', async () => {
    stubRequest({
      1: pageEnvelope(
        [
          { id: 1, email: '' },
          { id: 2, email: 'real@x.com' },
        ],
        1,
      ),
    });
    const hit = await abctrackService.findUserByEmail('real@x.com');
    expect(hit?.id).toBe(2);
    const miss = await abctrackService.findUserByEmail('');
    expect(miss).toBeNull();
  });
});
