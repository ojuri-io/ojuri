// Shared shell — Tabler icon wrapper, helpers, sidebar, page chrome, modal, toasts.

import React, { useState, useEffect, useCallback } from 'react';

// ──────── Tabler icon shorthand ────────
export function Ti({ name, size = 16, color, style, ...rest }) {
  return (
    <i
      className={'ti ti-' + name}
      style={{ fontSize: size, color, lineHeight: 1, ...style }}
      aria-hidden="true"
      {...rest}
    />
  );
}

// ──────── Permission helper ────────
// Mirrors the backend's check in src/shared/authz/auth.service.ts.
// `user.permissions` is a flat list; `*` wildcard means SUPER_ADMIN.
// Pass `null` or `undefined` `code` to mean "any authenticated user".
export function hasPermission(user, code) {
  if (!user) return false;
  const perms = user.permissions || [];
  if (perms.includes('*')) return true;
  if (!code) return true;
  if (Array.isArray(code)) return code.some((c) => perms.includes(c));
  return perms.includes(code);
}

// Small wrapper for buttons that need to be greyed out when the
// current user lacks a permission. Returns props you can spread.
// Usage: `<button {...permLock(user, 'users:create', 'Need users:create')}>…</button>`
export function permLock(user, code, friendlyHint) {
  if (hasPermission(user, code)) return {};
  return {
    disabled: true,
    title:
      friendlyHint ||
      `Requires the "${Array.isArray(code) ? code.join(' or ') : code}" permission`,
    'data-perm-locked': '1',
  };
}

// ──────── Money / time helpers ────────
// `n` may arrive as a string-numeric from pg numeric columns or as null /
// undefined when the row is sparse. Coerce defensively and fall back to
// "—" rather than rendering "₦NaN".
export const fmtNaira = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return '₦—';
  return '₦' + Math.round(num).toLocaleString();
};
export const fmtAge = (m) => {
  if (m == null) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60),
    mm = m % 60;
  if (m < 1440) return `${h}h ${mm}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};
export const ageTone = (m) =>
  m == null ? '' : m < 60 ? 'sec' : m < 240 ? 'warn' : 'danger';
// Tolerate non-string IDs — callers occasionally pass `null` from a row
// whose `transactionId` is missing, and `null.length` would throw.
export const truncId = (s, n = 8) => {
  const str = s == null ? '' : String(s);
  return str.length > n ? str.slice(0, n) + '…' : str;
};

// ──────── Pills ────────
export const verdictPill = (v) => {
  const map = {
    FRAUD_CONFIRMED: { c: 'danger', label: 'FRAUD_CONFIRMED' },
    UNCERTAIN: { c: 'warn', label: 'UNCERTAIN' },
    LIKELY_LEGITIMATE: { c: 'success', label: 'LIKELY_LEGITIMATE' },
  };
  const m = map[v] || { c: '', label: v };
  return <span className={'pill ' + m.c}>{m.label}</span>;
};

export const actionPill = (a) => {
  if (a === 'DENY' || a === 'DECLINE' || a === 'BLOCK')
    return <span className="pill danger">{a}</span>;
  if (a === 'ALLOW' || a === 'ACCEPT')
    return <span className="pill success">{a}</span>;
  if (a === 'REVIEW' || a === 'MANUAL_REVIEW')
    return <span className="pill warn">{a}</span>;
  return <span className="pill">{a}</span>;
};

export const statusPill = (s) => {
  if (s === 'ACTIVE') return <span className="pill success">ACTIVE</span>;
  if (s === 'SHADOW') return <span className="pill warn">SHADOW</span>;
  if (s === 'CANDIDATE') return <span className="pill">CANDIDATE</span>;
  if (s === 'RETIRED')
    return (
      <span className="pill" style={{ opacity: 0.65 }}>
        RETIRED
      </span>
    );
  return <span className="pill">{s}</span>;
};

// ──────── Toasts ────────
export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, kind = '', ttl = 3200) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);
  const node = (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          {t.msg}
        </div>
      ))}
    </div>
  );
  return [node, push];
}

// ──────── Sidebar ────────
export function Sidebar({ active, onNav, queueCount, user, onLogout }) {
  // Pages tagged with `perm` are read-gated. When the user lacks that
  // permission the nav item is shown but greyed out with a tooltip — that
  // way they discover the feature exists but can't enter the page and hit
  // a wall of 403s.
  const sections = [
    {
      label: null,
      items: [{ id: 'dash', label: 'Dashboard', icon: 'layout-dashboard' }],
    },
    {
      label: 'DETECTION',
      items: [
        { id: 'live', label: 'Live decisions', icon: 'activity-heartbeat' },
        { id: 'tx', label: 'Transactions', icon: 'arrows-exchange' },
        {
          id: 'queue',
          label: 'Review queue',
          icon: 'flag',
          count: queueCount,
          countKind: queueCount > 6 ? 'danger' : 'warn',
          perm: 'review_queue:read',
        },
        { id: 'invest', label: 'Investigations', icon: 'file-search', perm: 'reports:read' },
      ],
    },
    {
      label: 'INSIGHTS',
      items: [
        { id: 'audit', label: 'Audit log', icon: 'list-details', perm: 'audit:read' },
        { id: 'models', label: 'Models', icon: 'cpu', perm: 'models:read' },
        { id: 'metrics', label: 'Metrics', icon: 'chart-line', perm: 'metrics:read' },
        { id: 'reports', label: 'Reports', icon: 'report-analytics', perm: 'saved_reports:read' },
        { id: 'health', label: 'System health', icon: 'heartbeat' },
      ],
    },
    {
      label: 'CONFIG',
      items: [
        { id: 'rules', label: 'Rules', icon: 'shield-check', perm: 'rules:read' },
        { id: 'features', label: 'Features', icon: 'list-numbers', perm: 'models:read' },
        {
          id: 'integ',
          label: 'Integrations',
          icon: 'plug-connected',
          perm: ['api_keys:read', 'webhooks:read'],
        },
      ],
    },
    {
      label: 'ACCESS',
      items: [
        { id: 'users', label: 'Users', icon: 'users', perm: 'users:read' },
        { id: 'roles', label: 'Roles', icon: 'shield-lock', perm: 'roles:read' },
      ],
    },
  ].map((s) => ({
    ...s,
    items: s.items.map((it) => {
      if (!it.perm) return it;
      const allowed = hasPermission(user, it.perm);
      return allowed
        ? it
        : {
            ...it,
            disabled: true,
            disabledTitle: `Requires "${
              Array.isArray(it.perm) ? it.perm.join(' or ') : it.perm
            }" — ask an administrator to grant it.`,
          };
    }),
  }));

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="brand">
        <div className="brand-icon">
          <Ti name="shield-half" size={16} />
        </div>
        <span className="brand-name">Sentinel</span>
        <span className="brand-env">prod</span>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          overflow: 'auto',
          minHeight: 0,
        }}
      >
        {sections.map((s, si) => (
          <div key={si}>
            {s.label && <div className="nav-section-label">{s.label}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {s.items.map((it) => (
                <div
                  key={it.id}
                  className={
                    'nav-item ' +
                    (active === it.id ? 'active' : '') +
                    (it.disabled ? ' disabled' : '')
                  }
                  onClick={() => !it.disabled && onNav(it.id)}
                  title={it.disabledTitle || ''}
                  data-nav-id={it.id}
                >
                  <Ti name={it.icon} size={16} />
                  <span>{it.label}</span>
                  {typeof it.count === 'number' && (
                    <span className={'nav-count ' + (it.countKind || '')}>
                      {it.count}
                    </span>
                  )}
                  {it.disabled && (
                    <Ti
                      name="lock"
                      size={11}
                      style={{
                        marginLeft: 'auto',
                        color: 'var(--color-text-quaternary)',
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <div className="avatar">{initials(user)}</div>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--color-text-primary)',
            }}
            className="truncate"
          >
            {user?.fullName || user?.username || 'anonymous'}
          </span>
          <span
            className="truncate"
            style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}
            title={(user?.roles || []).map((r) => r.name).join(', ')}
          >
            {(user?.roles || []).map((r) => r.name).join(', ') || 'no role'}
          </span>
        </div>
        {onLogout && (
          <button
            className="ghost icon-only"
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out"
          >
            <Ti name="logout" size={14} />
          </button>
        )}
      </div>
    </aside>
  );
}

function initials(user) {
  if (!user) return '··';
  const src = user.fullName || user.username || '';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '··';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ──────── Page chrome ────────
export function PageHead({ crumbs, title, sub, children }) {
  return (
    <header className="page-head">
      <div>
        {crumbs && (
          <p className="crumbs">
            {crumbs.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="sep">›</span>}
                {c}
              </React.Fragment>
            ))}
          </p>
        )}
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {children && <div className="head-actions">{children}</div>}
    </header>
  );
}

// ──────── Modal ────────
export function Modal({ title, sub, onClose, children, footer, width }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={width ? { maxWidth: width } : {}}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
