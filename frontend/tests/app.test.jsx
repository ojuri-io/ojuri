import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import App from '../src/app.jsx';

/**
 * Test helpers. `<App />` first calls GET /v1/auth/me to validate the
 * stored JWT, then the dashboard hydrates by calling /v1/admin/*. We
 * mock fetch so neither call hits the network and so we can assert
 * mock-vs-live UI states.
 */
function authedFetch() {
  return vi.fn().mockImplementation((url) => {
    const u = String(url);
    if (u.endsWith('/v1/auth/me')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () =>
          Promise.resolve({
            status: true,
            data: {
              id: 'u1',
              username: 'admin',
              fullName: 'Default Admin',
              roles: [{ id: 'r1', name: 'SUPER_ADMIN' }],
              permissions: ['*'],
            },
          }),
        text: () => Promise.resolve(''),
      });
    }
    // Default: 503 so dashboard hydration sets the banner to OFFLINE.
    return Promise.resolve({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({}),
    });
  });
}

describe('App', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') window.location.hash = '';
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the login page when no JWT is stored', async () => {
    globalThis.fetch = authedFetch();
    await act(async () => {
      render(<App />);
    });
    expect(
      screen.getByText('Sign in to the fraud-ops dashboard.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/PASSWORD/i)).toBeInTheDocument();
  });

  it('renders the dashboard after a stored JWT validates against /v1/auth/me', async () => {
    localStorage.setItem('sentinel.jwt', 'stored-token');
    globalThis.fetch = authedFetch();

    await act(async () => {
      render(<App />);
    });
    // /v1/auth/me resolves async — wait for the gate to swap in the dashboard.
    // The "Things to do" panel header is a stable text landmark on the
    // dashboard; the old "Hello, X" greeting was dropped in favour of a
    // mono date stamp because operators use this every day.
    await waitFor(() => {
      expect(screen.getByText('Things to do')).toBeInTheDocument();
    });
    expect(screen.getByText(/^Today · /)).toBeInTheDocument();
  });

  it('exposes the Ojuri / sentinel wordmark in the sidebar once authed', async () => {
    localStorage.setItem('sentinel.jwt', 'stored-token');
    globalThis.fetch = authedFetch();
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => {
      expect(screen.getByText('Ojuri')).toBeInTheDocument();
    });
    expect(screen.getByText('sentinel')).toBeInTheDocument();
  });

  it('navigates to Live decisions when the hash changes', async () => {
    localStorage.setItem('sentinel.jwt', 'stored-token');
    globalThis.fetch = authedFetch();
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => screen.getByText('Things to do'));
    await act(async () => {
      window.location.hash = 'live';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Live decisions' }),
    ).toBeInTheDocument();
  });

  it('successful Login form submission swaps to the dashboard', async () => {
    // Login form posts to /v1/auth/login; subsequent fetches use authedFetch().
    const loginFetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith('/v1/auth/login')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              status: true,
              data: {
                token: 'fresh-token',
                user: {
                  id: 'u1',
                  username: 'admin',
                  fullName: 'Default Admin',
                  roles: [{ id: 'r1', name: 'SUPER_ADMIN' }],
                  permissions: ['*'],
                },
              },
            }),
        });
      }
      // Hydration calls — return 503 so banner reads OFFLINE after login.
      return Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      });
    });
    globalThis.fetch = loginFetch;

    await act(async () => {
      render(<App />);
    });
    // We start on the Login page.
    expect(screen.getByLabelText(/USERNAME/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/PASSWORD/i), {
      target: { value: 'admin@fraudit' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Sign in/i }));
    });
    await waitFor(() => {
      expect(screen.getByText('Things to do')).toBeInTheDocument();
    });
    expect(localStorage.getItem('sentinel.jwt')).toBe('fresh-token');
  });
});
