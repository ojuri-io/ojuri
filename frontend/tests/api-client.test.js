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
import { MOCK } from '../src/data/mock.js';

describe('api/client safe()', () => {
  beforeEach(() => {
    // Reset overrides between tests.
    try {
      localStorage.removeItem('sentinel.useMock');
    } catch {
      /* not in a browser env */
    }
  });

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

  it('respects the localStorage useMock override', async () => {
    try {
      localStorage.setItem('sentinel.useMock', '1');
    } catch {
      // No localStorage means the override is a no-op; skip.
      return;
    }
    const fellBack = await safe(
      () => Promise.resolve('live'),
      () => 'mock',
    );
    expect(fellBack).toBe('mock');
  });
});

describe('api/client fallbacks', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // The earlier describe's "useMock override" test leaves the flag set;
    // clear it so we exercise the real live → fallback path here.
    try {
      localStorage.removeItem('sentinel.useMock');
    } catch {
      /* no localStorage */
    }
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('listApiKeys returns an empty list when fetch fails (no mock fallback)', async () => {
    // Adopters were confused by demo URLs/keys appearing on Integrations
    // when the API was unreachable; we no longer fall back to MOCK for
    // credential-shaped data — an empty list is the honest signal.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await listApiKeys();
    expect(out).toEqual([]);
  });

  it('listRules falls back to MOCK.rules when fetch returns 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Error',
      text: () => Promise.resolve('boom'),
    });
    const out = await listRules();
    expect(out).toEqual(MOCK.rules);
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
