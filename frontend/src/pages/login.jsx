// Login page — the first thing an unauthenticated visitor sees.
// Posts to POST /v1/auth/login on the RDA backend, stores the JWT,
// then signals the app shell to swap in the dashboard.
//
// Design — Ojuri brand spec §7:
// - Centered 380px card, vertically centered viewport.
// - Monogram only (28px); no wordmark duplicate, no "sentinel" sub-label.
// - One sans 14px helper paragraph in --ink-muted.
// - USERNAME + PASSWORD inputs using the standard form pattern.
// - Sign-in button starts disabled and enables when both trimmed inputs
//   are non-empty; we keep the 'admin' username prefill so first-run
//   sign-in works without typing — the password is still required.
// - FIRST-RUN SEED helper at the bottom: thin top border, mono eyebrow,
//   one sans body line with mono-chip code spans.

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

  const trimmedUser = username.trim();
  const canSubmit = !busy && trimmedUser.length > 0 && password.length > 0;

  const submit = async (e) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const res = await apiLogin({ username: trimmedUser, password });
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
          'Authentication is not configured on the server. Set AUTH_JWT_SECRET in the RDA .env and restart.',
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
          maxWidth: 380,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          padding: '32px 32px 28px',
        }}
      >
        {/* Monogram only — the wordmark, sub-label and any marketing
            chrome are intentionally absent on this operator surface. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            color: 'var(--ink)',
            marginBottom: 18,
          }}
        >
          <Monogram size={28} aria-hidden />
        </div>

        <p
          style={{
            margin: '0 0 22px',
            fontFamily: 'var(--font-sans)',
            fontSize: 14,
            color: 'var(--ink-muted)',
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          Sign in to the fraud-ops dashboard.
        </p>

        <label
          className="label-up"
          htmlFor="login-username"
          style={{ display: 'block', marginBottom: 6 }}
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
          style={{ width: '100%', marginBottom: 14 }}
        />

        <label
          className="label-up"
          htmlFor="login-password"
          style={{ display: 'block', marginBottom: 6 }}
        >
          PASSWORD
        </label>
        <PasswordInput
          id="login-password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ marginBottom: 16 }}
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
          disabled={!canSubmit}
          style={{
            width: '100%',
            justifyContent: 'center',
            padding: '9px 12px',
            fontSize: 13,
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {/* First-run seed helper. Stays at the bottom because the
            credentials it documents only matter on a fresh install;
            returning operators ignore it. The mono code chips reuse
            the existing .mono class to inherit JetBrains Mono. */}
        <div
          style={{
            borderTop: '1px solid var(--border)',
            marginTop: 22,
            paddingTop: 16,
          }}
        >
          <p
            style={{
              margin: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--ink-faint)',
              lineHeight: 1,
            }}
          >
            First-run seed
          </p>
          <p
            style={{
              margin: '8px 0 0',
              fontFamily: 'var(--font-sans)',
              fontSize: 12.5,
              color: 'var(--ink-muted)',
              lineHeight: 1.55,
            }}
          >
            Sign in with <code className="mono">admin</code> /{' '}
            <code className="mono">admin@fraudit</code>, then rotate the
            password via <code className="mono">PATCH /v1/admin/users/:id</code>.
          </p>
        </div>
      </form>
    </div>
  );
}

export default Login;
