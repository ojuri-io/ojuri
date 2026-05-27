// Login page — the first thing an unauthenticated visitor sees.
// Posts to POST /v1/auth/login on the RDA backend, stores the JWT,
// then signals the app shell to swap in the dashboard.

import React, { useState } from 'react';
import { Ti } from '../components/shell.jsx';
import { Monogram } from '../components/monogram.jsx';
import { PasswordInput } from '../components/password-input.jsx';
import { login as apiLogin } from '../api/client.js';

function Login({ onSuccess }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e?.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiLogin({ username: username.trim(), password });
      if (!res?.token) throw new Error('Backend returned no token');
      localStorage.setItem('sentinel.jwt', res.token);
      try {
        localStorage.setItem('sentinel.user', JSON.stringify(res.user || {}));
      } catch {
        /* localStorage write can fail in private windows — non-fatal */
      }
      onSuccess(res);
    } catch (err) {
      const msg = String(err.message || err);
      // Map common shapes to friendlier UI strings.
      if (msg.includes('401') || /Invalid/i.test(msg)) {
        setError('Invalid username or password.');
      } else if (msg.includes('503')) {
        setError(
          'Authentication is not configured on the server. Set AUTH_JWT_SECRET in the RDA .env and restart.'
        );
      } else if (msg.includes('Failed to fetch') || /NetworkError/i.test(msg)) {
        setError('Could not reach the RDA backend. Is it running on :3000?');
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--surface)',
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: '100%',
          maxWidth: 360,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: '32px 32px 24px',
        }}
      >
        <div style={{ marginBottom: 22 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              color: 'var(--ink)',
            }}
          >
            <Monogram size={40} aria-hidden />
            <div>
              <h1
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-display)',
                  fontSize: 32,
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  color: 'var(--ink)',
                  lineHeight: 1,
                }}
              >
                Ojuri<span style={{ fontWeight: 700 }}>.</span>
              </h1>
              <p
                style={{
                  margin: '6px 0 0',
                  fontFamily: 'var(--font-code)',
                  fontSize: 12,
                  color: 'var(--ink-muted)',
                  lineHeight: 1,
                }}
              >
                sentinel
              </p>
            </div>
          </div>
          <p
            style={{
              margin: '14px 0 0',
              fontSize: 13,
              color: 'var(--ink-secondary)',
            }}
          >
            Sign in to the fraud-ops dashboard.
          </p>
        </div>

        <label
          className="label-up"
          htmlFor="login-username"
          style={{ display: 'block', marginBottom: 4 }}
        >
          USERNAME
        </label>
        <input
          id="login-username"
          autoFocus
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          style={{ width: '100%', marginBottom: 12 }}
        />

        <label
          className="label-up"
          htmlFor="login-password"
          style={{ display: 'block', marginBottom: 4 }}
        >
          PASSWORD
        </label>
        <PasswordInput
          id="login-password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ marginBottom: 14 }}
        />

        {error && (
          <div
            className="banner danger"
            style={{ fontSize: 11, marginBottom: 12, padding: '8px 10px' }}
          >
            <Ti name="alert-circle" size={12} className="b-icon" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          className="primary"
          disabled={busy || !username.trim() || !password}
          style={{
            width: '100%',
            justifyContent: 'center',
            padding: '9px 12px',
            fontSize: 13,
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p
          style={{
            margin: '14px 0 0',
            fontSize: 10,
            color: 'var(--color-text-tertiary)',
            textAlign: 'center',
          }}
        >
          First-run password is printed once by{' '}
          <code className="mono">npm run db:migrate</code>. Lost it?
          <br />
          Run <code className="mono">npm run reset:admin</code> from the repo root.
        </p>
      </form>
    </div>
  );
}

export default Login;
