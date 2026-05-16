// Forced password-change screen. Shown when the authenticated user
// still has `mustChangePassword=true` — typically the seeded admin on
// first login, or any account created by an operator with a temp
// password. The server enforces the same gate at the
// `denyIfPasswordRotation` middleware, so a user can't reach any
// admin route until they complete this flow.

import React, { useMemo, useState } from 'react';
import { Ti } from '../components/shell.jsx';
import { changePassword as apiChangePassword, me as apiMe } from '../api/client.js';
import {
  evaluatePassword,
  CHECK_LABELS,
  SCORE_LABELS,
  SCORE_TONE,
  MIN_LENGTH,
} from '../utils/password-policy.js';

function ChangePassword({ user, onSuccess, onLogout }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Live policy evaluation. Same rules the server runs at
  // POST /v1/auth/change-password — so any "ok=true" here will pass
  // server-side too (barring a stale frontend bundle).
  const policy = useMemo(
    () =>
      evaluatePassword(next, {
        username: user?.username,
        currentPassword: current,
      }),
    [next, current, user?.username],
  );

  const mismatch = !!confirm && next !== confirm;

  const submit = async (e) => {
    e?.preventDefault();
    if (!current || !next || !confirm) return;
    if (mismatch || !policy.ok) return;
    setBusy(true);
    setError('');
    try {
      await apiChangePassword({ currentPassword: current, newPassword: next });
      // Re-fetch /me so the app shell picks up the cleared flag and
      // the freshest role list in one go.
      const refreshed = await apiMe();
      try {
        localStorage.setItem('sentinel.user', JSON.stringify(refreshed || {}));
      } catch {
        /* private window — ignore */
      }
      onSuccess(refreshed);
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes('401')) setError('Current password is incorrect.');
      else if (msg.includes('400')) setError(msg.replace(/^400[^:]*:\s*/, ''));
      else if (msg.includes('Failed to fetch')) setError('Could not reach the RDA backend.');
      else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const blockSubmit = busy || !current || !next || !confirm || mismatch || !policy.ok;

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
          maxWidth: 400,
          background: 'var(--color-background-primary)',
          border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          padding: '28px 28px 22px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: 'var(--color-background-warning)',
              color: 'var(--color-text-warning)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ti name="lock" size={18} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 500, letterSpacing: '-0.01em' }}>
              Set a new password
            </h1>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              Signed in as <strong>{user?.username || 'user'}</strong> — pick your own secret before continuing.
            </p>
          </div>
        </div>

        <div
          className="banner info"
          style={{ fontSize: 11, marginBottom: 14, padding: '8px 10px' }}
        >
          <Ti name="info-circle" size={12} className="b-icon" />
          <span>
            The default credential is shared across deployments. Rotate it now;
            we won't allow access to any admin feature until you do.
          </span>
        </div>

        <Field id="cp-current" label="CURRENT PASSWORD" autoFocus>
          <input
            id="cp-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            style={{ width: '100%' }}
          />
        </Field>

        <Field id="cp-new" label={`NEW PASSWORD · MIN ${MIN_LENGTH} CHARS`}>
          <input
            id="cp-new"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            style={{ width: '100%' }}
          />
          {next && <StrengthMeter score={policy.score} />}
          {next && <PolicyChecklist checks={policy.checks} />}
        </Field>

        <Field id="cp-confirm" label="CONFIRM NEW PASSWORD">
          <input
            id="cp-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={{ width: '100%' }}
          />
          {mismatch && (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--color-text-danger)' }}>
              Confirmation doesn't match.
            </p>
          )}
        </Field>

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
          disabled={blockSubmit}
          style={{ width: '100%', justifyContent: 'center', padding: '9px 12px', fontSize: 13 }}
        >
          {busy ? 'Updating…' : 'Update password and continue'}
        </button>

        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className="ghost"
            style={{
              marginTop: 10,
              width: '100%',
              justifyContent: 'center',
              padding: '7px 12px',
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
            }}
          >
            Sign out instead
          </button>
        )}
      </form>
    </div>
  );
}

function Field({ id, label, children }) {
  return (
    <>
      <label className="label-up" htmlFor={id} style={{ display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      <div style={{ marginBottom: 12 }}>{children}</div>
    </>
  );
}

/**
 * Four-bar password strength meter. Bars light up cumulatively as the
 * score climbs (1..4). Tone tracks the `SCORE_TONE` map so weak/fair
 * read red/amber and strong/very-strong read green.
 */
function StrengthMeter({ score }) {
  const tone = SCORE_TONE[score] || 'danger';
  const colour = `var(--color-text-${tone === 'success' ? 'success' : tone})`;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 3 }}>
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background:
                i <= score ? colour : 'var(--color-background-tertiary)',
              transition: 'background 0.15s',
            }}
          />
        ))}
      </div>
      <p
        style={{
          margin: '4px 0 0',
          fontSize: 10,
          color: `var(--color-text-${tone})`,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          fontWeight: 500,
        }}
      >
        {SCORE_LABELS[score]}
      </p>
    </div>
  );
}

/** Live tick-list of each rule. Failures stay grey until they pass. */
function PolicyChecklist({ checks }) {
  const items = Object.keys(CHECK_LABELS).map((k) => ({
    key: k,
    label: CHECK_LABELS[k],
    ok: !!checks[k],
  }));
  return (
    <ul
      style={{
        margin: '8px 0 0',
        padding: 0,
        listStyle: 'none',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '3px 10px',
      }}
    >
      {items.map((it) => (
        <li
          key={it.key}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10.5,
            color: it.ok
              ? 'var(--color-text-success)'
              : 'var(--color-text-tertiary)',
          }}
        >
          <Ti name={it.ok ? 'check' : 'point'} size={11} />
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

export default ChangePassword;
