import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  safe,
  listApiKeys,
  listRules,
  listRecentDecisions,
  listReasonCodes,
  getStatsWindow,
  getServiceHealth,
  listReports,
} from '../src/api/client.js';

describe('api/client safe()', () => {
  it('returns the live value when the call succeeds', async () => {
    const out = await safe(
      () => Promise.resolve({ ok: true }),
      () => ({ ok: false }),
    );
    expect(out).toEqual({ ok: true });
  });

  it('falls back when the live call throws', async () => {
    const out = await safe(
      () => Promise.reject(new Error('boom')),
      () => ({ fellBack: true }),
    );
    expect(out).toEqual({ fellBack: true });
  });

});

describe('api/client fallbacks', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('listApiKeys returns an empty list when fetch fails', async () => {
    // Adopters were confused by demo URLs/keys appearing on Integrations
    // when the API was unreachable; we no longer fall back to any
    // seeded data — an empty list is the honest signal.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await listApiKeys();
    expect(out).toEqual([]);
  });

  it('listRules returns an empty list when fetch returns 500', async () => {
    // Same reasoning as listApiKeys above: an empty list is the honest
    // signal when the backend isn't reachable, not a fake rule the
    // operator can't actually delete or toggle.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Error',
      text: () => Promise.resolve('boom'),
    });
    const out = await listRules();
    expect(out).toEqual([]);
  });

  it('listRecentDecisions returns an empty array when the live call fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await listRecentDecisions({ since: new Date().toISOString() });
    expect(out).toEqual([]);
  });

  it('listRecentDecisions unwraps `{ data }` envelope on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: true,
          message: 'ok',
          data: [{ id: 'aud_1', transactionId: 't_1', finalDecision: 'ACCEPT' }],
        }),
    });
    const out = await listRecentDecisions({ limit: 50 });
    expect(out).toHaveLength(1);
    expect(out[0].transactionId).toBe('t_1');
  });

  it('listReasonCodes returns [] when unauthorised', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve(''),
    });
    const out = await listReasonCodes();
    expect(out).toEqual([]);
  });

  it('getStatsWindow falls back to null on failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));
    const out = await getStatsWindow({ seconds: 3600 });
    expect(out).toBeNull();
  });

  it('getServiceHealth falls back to []', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));
    const out = await getServiceHealth();
    expect(out).toEqual([]);
  });

  it('listReports surfaces { reports, live: false } when FIA is offline', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const out = await listReports();
    expect(out.live).toBe(false);
    expect(out.reports).toEqual([]);
  });

  it('listReports surfaces { reports, live: true } when FIA responds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 'r_1', transactionId: 't_1' }]),
    });
    const out = await listReports();
    expect(out.live).toBe(true);
    expect(out.reports).toEqual([{ id: 'r_1', transactionId: 't_1' }]);
  });
});
