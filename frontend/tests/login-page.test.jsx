import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const signInOptions = vi.fn();

vi.mock('../src/api/client.js', () => ({
  login: vi.fn(),
  signInOptions: (...args) => signInOptions(...args),
}));

const { default: Login } = await import('../src/pages/login.jsx');

const username = () => document.getElementById('login-username');

describe('Login', () => {
  beforeEach(() => {
    signInOptions.mockReset();
  });

  it('keeps the admin prefill and first-run instructions on a self-hosted install', async () => {
    signInOptions.mockResolvedValue({ demoAccount: null });
    render(<Login onSuccess={() => {}} />);

    await waitFor(() => expect(signInOptions).toHaveBeenCalled());
    expect(username().value).toBe('admin');
    expect(screen.getByText(/npm run db:migrate/)).toBeInTheDocument();
    expect(screen.queryByText(/public sandbox/i)).not.toBeInTheDocument();
  });

  it('switches to the demo account and sandbox guidance when one is published', async () => {
    signInOptions.mockResolvedValue({
      demoAccount: { username: 'demo', credentialsUrl: 'https://ojuri.io/#sandbox' },
    });
    render(<Login onSuccess={() => {}} />);

    await waitFor(() => expect(username().value).toBe('demo'));
    expect(screen.queryByText(/npm run db:migrate/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /alongside the sandbox link/i })).toHaveAttribute(
      'href',
      'https://ojuri.io/#sandbox'
    );
  });

  it('renders the guidance without a link when no credentials URL is configured', async () => {
    signInOptions.mockResolvedValue({ demoAccount: { username: 'demo', credentialsUrl: null } });
    render(<Login onSuccess={() => {}} />);

    await waitFor(() => expect(username().value).toBe('demo'));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not overwrite a username the visitor has already typed', async () => {
    let resolveOptions;
    signInOptions.mockReturnValue(new Promise((r) => { resolveOptions = r; }));
    render(<Login onSuccess={() => {}} />);

    fireEvent.change(username(), { target: { value: 'analyst' } });
    resolveOptions({ demoAccount: { username: 'demo', credentialsUrl: null } });

    await waitFor(() => expect(screen.getByText(/public sandbox/i)).toBeInTheDocument());
    expect(username().value).toBe('analyst');
  });
});
