// Login page — the first thing an unauthenticated visitor sees.
// Posts to POST /v1/auth/login on the RDA backend, stores the JWT,
// then signals the app shell to swap in the dashboard.

import React, { useState } from 'react';
import { Ti } from '../components/shell.jsx';
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
        background: 'var(--color-background-secondary)',
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: '100%',
          maxWidth: 360,
          background: 'var(--color-background-primary)',
          border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          padding: '28px 28px 22px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 18,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'var(--color-background-info)',
              color: 'var(--color-text-info)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ti name="shield-half" size={18} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 500, letterSpacing: '-0.01em' }}>
              Sentinel
            </h1>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              Sign in to the fraud-ops dashboard
            </p>
          </div>
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
          First-run seed: <code className="mono">admin / admin@fraudit</code>. Change it via
          <br />
          <code className="mono">PATCH /v1/admin/users/:id</code> after sign-in.
        </p>
      </form>
    </div>
  );
}

export default Login;
