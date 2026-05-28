// Shared shell — Lucide icon wrapper, helpers, sidebar, topbar, page chrome, modal, toasts.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Activity,
  ArrowDownNarrowWide,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpNarrowWide,
  Ban,
  Bell,
  Bookmark,
  Bot,
  Braces,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Copy,
  Cpu,
  Download,
  EllipsisVertical,
  Eye,
  EyeOff,
  ExternalLink,
  FileSearch,
  FileText,
  Filter,
  Flag,
  FormInput,
  GitFork,
  HeartPulse,
  History,
  Info,
  LayoutDashboard,
  LineChart,
  ListChecks,
  ListOrdered,
  Loader2,
  Lock,
  LogOut,
  Menu,
  MessageCircle,
  Dot,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  Save,
  Send,
  Settings,
  ShieldCheck,
  ShieldX,
  Shuffle,
  SkipForward,
  Sparkles,
  Target,
  Terminal,
  Trash2,
  TriangleAlert,
  Users as UsersIcon,
  Webhook,
  X,
  Zap,
} from 'lucide-react';

// ──────── Icon wrapper ────────
// `<Ti name="..." />` renders a Lucide icon at stroke-width 1.5 (the
// Ojuri brand spec — see BRAND.md §3.7). The historical Tabler vocabulary
// is preserved in the lookup table so the 100+ existing callsites don't
// have to change; new icons should still be added via Lucide naming.
const ICON_MAP = {
  'activity-heartbeat': Activity,
  affiliate: GitFork,
  'alert-circle': CircleAlert,
  'alert-triangle': TriangleAlert,
  'arrow-narrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'arrows-exchange': ArrowLeftRight,
  'arrows-shuffle': Shuffle,
  ban: Ban,
  bell: Bell,
  bolt: Zap,
  bookmark: Bookmark,
  braces: Braces,
  'chart-line': LineChart,
  check: Check,
  'device-floppy': Save,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'circle-check': CircleCheck,
  copy: Copy,
  cpu: Cpu,
  'dots-vertical': EllipsisVertical,
  download: Download,
  edit: Pencil,
  eye: Eye,
  'eye-off': EyeOff,
  'external-link': ExternalLink,
  'file-search': FileSearch,
  'file-type-csv': FileText,
  filter: Filter,
  flag: Flag,
  forms: FormInput,
  heartbeat: HeartPulse,
  'help-circle': CircleHelp,
  history: History,
  'info-circle': Info,
  'layout-dashboard': LayoutDashboard,
  'list-details': ListChecks,
  'list-numbers': ListOrdered,
  'loader-2': Loader2,
  lock: Lock,
  logout: LogOut,
  menu: Menu,
  'message-circle': MessageCircle,
  pencil: Pencil,
  pause: Pause,
  'player-pause': Pause,
  play: Play,
  'player-play': Play,
  'player-skip-forward': SkipForward,
  'plug-connected': Plug,
  plus: Plus,
  point: Dot,
  refresh: RefreshCw,
  'report-analytics': ChartColumn,
  robot: Bot,
  search: Search,
  'search-off': SearchX,
  send: Send,
  settings: Settings,
  'shield-check': ShieldCheck,
  // Lucide doesn't ship a shield-lock; the Roles surface uses a plain
  // lock — same connotation, brand-consistent.
  'shield-lock': Lock,
  'shield-x': ShieldX,
  'sort-ascending': ArrowUpNarrowWide,
  'sort-descending': ArrowDownNarrowWide,
  sparkles: Sparkles,
  target: Target,
  terminal: Terminal,
  trash: Trash2,
  users: UsersIcon,
  webhook: Webhook,
  x: X,
};

export function Ti({ name, size = 16, color, style, ...rest }) {
  const Icon = ICON_MAP[name];
  if (!Icon) {
    // Missing icon: render a thin square so the layout reserves space and
    // the gap is visually obvious to a maintainer rather than silently zero-width.
    if (typeof console !== 'undefined') console.warn(`Ti: unknown icon "${name}"`);
    return (
      <span
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          border: '1px dashed var(--ink-disabled)',
          borderRadius: 2,
          ...style,
        }}
        aria-hidden="true"
        {...rest}
      />
    );
  }
  return (
    <Icon
      size={size}
      color={color}
      strokeWidth={1.5}
      aria-hidden="true"
      style={{ flexShrink: 0, verticalAlign: 'text-bottom', ...style }}
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

// ──────── User-name helpers ────────
// First name preferred for greetings; falls back to username, then a generic
// stand-in so the greeting never reads as "Hello, ".
export function firstName(user) {
  if (!user) return 'there';
  const full = (user.fullName || '').trim();
  if (full) return full.split(/\s+/)[0];
  return user.username || 'there';
}

// Short display name for attribution lines ("Reviewer: X"). Prefers
// "First L." form when a last name exists; falls back to username.
export function displayName(user) {
  if (!user) return '—';
  const parts = (user.fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1][0]}.`;
  if (parts.length === 1) return parts[0];
  return user.username || '—';
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
// `user` is still required for permission gating on nav items (read-locked
// pages are greyed out for users that lack the perm). The identity surface
// and sign-out moved to the global Topbar — see <Topbar> below.
//
// `mobileOpen` / `onClose` are optional — when omitted the sidebar renders
// in its desktop layout (always visible). The parent wires those props
// when running responsive: `<Sidebar mobileOpen={drawerOpen} onClose={…} />`
// flips the `.sidebar--open` class and renders the click-to-dismiss backdrop.
export function Sidebar({ active, onNav, queueCount, user, mobileOpen, onClose }) {
  // Esc-to-close when the drawer is open. Skip attaching the listener
  // entirely on desktop (no drawer state) so this isn't running for
  // every operator who lives in this app.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onClose]);
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
        { id: 'settings', label: 'Settings', icon: 'settings', perm: 'settings:read' },
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

  const sidebarClass = 'sidebar' + (mobileOpen ? ' sidebar--open' : '');
  const handleNav = (id) => {
    onNav(id);
    if (onClose) onClose();
  };

  return (
    <>
      {onClose && (
        <div
          className={
            'sidebar-backdrop' + (mobileOpen ? ' sidebar-backdrop--show' : '')
          }
          onClick={onClose}
          aria-hidden="true"
        />
      )}
    <aside
      className={sidebarClass}
      data-testid="sidebar"
      aria-hidden={onClose ? !mobileOpen : undefined}
    >
      <div className="brand">
        {/* Wordmark only — operators see this constantly; doubling
            the monogram next to the wordmark stacks three identifiers
            (mark + name + product). Pick one — the wordmark wins
            because "sentinel" still needs the product context. */}
        <span className="brand-mark">
          Ojuri<span className="brand-dot">.</span>
        </span>
        <span className="brand-sep">/</span>
        <span className="brand-sub">sentinel</span>
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
                  onClick={() => !it.disabled && handleNav(it.id)}
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
                        color: 'var(--ink-disabled)',
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
    </>
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

// ──────── Topbar ────────
// Global app chrome — date stamp on the left, bell + user menu on the right.
// Lives in every authenticated page; do not put page-scoped controls here.
// Notifications are computed by the parent (so the bell count matches what
// the dashboard surfaces) via `computeNotifications` below.
//
// `onMenuClick` is optional — when passed, a hamburger button appears on
// the leading edge of the topbar. CSS hides it on desktop and shows it
// on tablet / phone. Wiring this is how the parent opens the responsive
// sidebar drawer.
export function Topbar({
  dateLabel,
  notifications,
  user,
  onLogout,
  onMenuClick,
  // `lastSeenAt` (ISO string or null) + `onMarkSeen` wire the unread-badge
  // tracking: badge counts only items whose anchor is newer than lastSeenAt,
  // and opening the bell calls onMarkSeen() — which POSTs /v1/notifications/seen
  // and bumps the timestamp. Both are optional; omitting them falls back to
  // the legacy "badge = total backlog count" behaviour so older callsites
  // keep working unchanged.
  lastSeenAt,
  onMarkSeen,
}) {
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bellRef = useRef(null);
  const menuRef = useRef(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!bellOpen && !menuOpen) return;
    const onDown = (e) => {
      if (bellOpen && bellRef.current && !bellRef.current.contains(e.target)) {
        setBellOpen(false);
      }
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setBellOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [bellOpen, menuOpen]);

  const items = notifications || [];
  // `unread` drives the red badge on the bell. When the parent wires
  // unread tracking (passes `lastSeenAt`), count only items whose anchor
  // is newer than lastSeenAt; otherwise fall back to total backlog so
  // legacy callsites keep their previous behaviour.
  const total = items.length;
  const unread =
    lastSeenAt !== undefined ? unreadCount(items, lastSeenAt) : total;
  const roles = (user?.roles || []).map((r) => r.name).join(', ') || 'no role';

  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar-left">
        {onMenuClick && (
          <button
            type="button"
            className="ghost icon-only topbar-menu"
            aria-label="Open navigation menu"
            onClick={onMenuClick}
          >
            <Ti name="menu" size={16} />
          </button>
        )}
        {dateLabel && <span className="topbar-date">{dateLabel}</span>}
      </div>
      <div className="topbar-actions">
        <div className="topbar-pop-anchor" ref={bellRef}>
          <button
            type="button"
            className="ghost icon-only topbar-bell"
            aria-label={
              unread ? `Notifications (${unread} unread)` : 'Notifications'
            }
            aria-haspopup="true"
            aria-expanded={bellOpen}
            onClick={() => {
              setBellOpen((o) => {
                // Fire onMarkSeen on the open transition only — the
                // close transition shouldn't re-stamp seen, and the
                // already-open click (a close) is the only other path
                // here. Wrapped in a guard so the callback stays
                // optional for legacy callers.
                if (!o && onMarkSeen) {
                  try {
                    onMarkSeen();
                  } catch {
                    /* parent surfaces errors; never block the toggle */
                  }
                }
                return !o;
              });
              setMenuOpen(false);
            }}
          >
            <Ti name="bell" size={15} />
            {unread > 0 && (
              <span className="topbar-badge" aria-hidden="true">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          {bellOpen && (
            <div
              className="popover popover--right"
              role="dialog"
              aria-label="Notifications"
            >
              <div className="popover-head">
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  Notifications
                </span>
                <span style={{ fontSize: 11, color: 'var(--ink-muted)' }}>
                  {total} {total === 1 ? 'item' : 'items'}
                </span>
              </div>
              {total === 0 ? (
                <div className="popover-empty">You're all caught up.</div>
              ) : (
                <div className="notif-list">
                  {items.map((n, i) => (
                    <button
                      key={i}
                      type="button"
                      className="notif-item"
                      onClick={() => {
                        setBellOpen(false);
                        n.onClick && n.onClick();
                      }}
                    >
                      <Ti
                        name={n.icon}
                        size={14}
                        style={{
                          color: 'var(--ink-muted)',
                          marginTop: 2,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className="notif-title">{n.title}</span>
                        <span className="notif-sub truncate">{n.sub}</span>
                      </div>
                      <span className="notif-when">{n.when}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="topbar-pop-anchor" ref={menuRef}>
          <button
            type="button"
            className="ghost topbar-user"
            aria-label="User menu"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((o) => !o);
              setBellOpen(false);
            }}
          >
            <span className="avatar avatar--sm" aria-hidden="true">
              {initials(user)}
            </span>
            <span className="topbar-user-name truncate">
              {user?.fullName || user?.username || 'anonymous'}
            </span>
            <Ti
              name="chevron-down"
              size={12}
              style={{ color: 'var(--ink-muted)' }}
            />
          </button>
          {menuOpen && (
            <div
              className="popover popover--right popover--narrow"
              role="menu"
              aria-label="User menu"
            >
              <div className="user-menu-head">
                <span className="avatar" aria-hidden="true">
                  {initials(user)}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span
                    className="truncate"
                    style={{
                      display: 'block',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--ink)',
                    }}
                  >
                    {user?.fullName || user?.username || 'anonymous'}
                  </span>
                  <span
                    className="truncate"
                    style={{
                      display: 'block',
                      fontSize: 11,
                      color: 'var(--ink-muted)',
                    }}
                    title={roles}
                  >
                    {roles}
                  </span>
                </div>
              </div>
              {onLogout && (
                <div className="user-menu-actions">
                  <button
                    type="button"
                    className="user-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogout();
                    }}
                    aria-label="Sign out"
                  >
                    <Ti name="logout" size={14} />
                    <span>Sign out</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// Build the notification list shown by the bell popover. Mirrors the
// dashboard's "Things to do" so the bell count never disagrees with the
// page below it. Pure function — no hooks, no network — so it can be
// recomputed cheaply on every render of the parent.
//
// Each item carries an `anchor` ISO timestamp (or null) representing
// the freshness of the driving event. The Topbar compares this anchor
// against the user's `lastNotificationSeenAt` to compute the unread
// badge count — items whose source has moved since the last bell open
// count as unread, the rest stay in the popover as "backlog still
// needs your attention" without nagging the badge. A null anchor means
// "we don't know how fresh this is" and falls through as unread, which
// keeps the bell honest when timestamps aren't available yet.
export function computeNotifications({
  queueCount,
  queue,
  reports,
  models,
  webhooks,
  nav,
}) {
  const items = [];
  const toIso = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const maxCreatedAt = (rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    let best = 0;
    for (const r of rows) {
      const t = new Date(r?.createdAt || 0).getTime();
      if (t > best) best = t;
    }
    return best > 0 ? new Date(best).toISOString() : null;
  };

  const qCount =
    typeof queueCount === 'number' ? queueCount : Array.isArray(queue) ? queue.length : 0;
  if (qCount > 0) {
    items.push({
      icon: 'flag',
      title: `${qCount} declined transaction${qCount === 1 ? '' : 's'} pending review`,
      sub: 'Operator action needed in the review queue.',
      when: 'Now',
      anchor: maxCreatedAt(queue),
      onClick: () => nav && nav('queue'),
    });
  }
  const recentReports = Array.isArray(reports) ? reports.slice(0, 4) : [];
  if (recentReports.length > 0) {
    const fraud = recentReports.filter((r) => r.verdict === 'FRAUD_CONFIRMED').length;
    items.push({
      icon: 'file-search',
      title: `${recentReports.length} new investigation report${recentReports.length === 1 ? '' : 's'}`,
      sub: `${fraud} fraud confirmed · phi-3-mini`,
      when: 'Today',
      anchor: maxCreatedAt(recentReports),
      onClick: () => nav && nav('invest'),
    });
  }
  const shadow = Array.isArray(models) ? models.find((m) => m.status === 'SHADOW') : null;
  if (shadow) {
    items.push({
      icon: 'cpu',
      title: `Model ${shadow.version} ready to activate`,
      sub: 'Promote shadow → active in the Models page.',
      when: 'Today',
      anchor: toIso(shadow.createdAt || shadow.updatedAt),
      onClick: () => nav && nav('models'),
    });
  }
  const failing = Array.isArray(webhooks) ? webhooks.filter((w) => w.status === 'failing') : [];
  if (failing.length > 0) {
    // Failing webhooks don't carry a uniform `createdAt`; fall back to
    // `updatedAt` and finally `lastDelivery.timestamp`. Null is fine —
    // unknown = unread, which is the safe default.
    const anchor = (() => {
      let best = 0;
      for (const w of failing) {
        const t = new Date(
          w?.updatedAt || w?.lastDelivery?.timestamp || 0,
        ).getTime();
        if (t > best) best = t;
      }
      return best > 0 ? new Date(best).toISOString() : null;
    })();
    items.push({
      icon: 'webhook',
      title: `${failing.length} webhook deliver${failing.length === 1 ? 'y' : 'ies'} failing`,
      sub: 'Check Integrations.',
      when: 'Recent',
      anchor,
      onClick: () => nav && nav('integ'),
    });
  }
  return items;
}

// How many notification items count as "unread" relative to a given
// `lastSeenAt` ISO timestamp. Pure helper so the Topbar and any future
// consumer compute the same number.
//
//   anchor missing      → unread (defensive)
//   no lastSeenAt yet   → all unread (first-time user)
//   anchor > lastSeenAt → unread
//   anchor ≤ lastSeenAt → seen
export function unreadCount(items, lastSeenAt) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  if (!lastSeenAt) return items.length;
  const seenMs = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seenMs)) return items.length;
  let n = 0;
  for (const it of items) {
    // No anchor → we can't prove the item is newer than `lastSeenAt`.
    // Once the user has acknowledged the bell at least once
    // (lastSeenAt is set, which the early-return above guarantees),
    // treat anchorless items as seen so the badge can actually drop
    // to zero. Without this, items derived from props the dashboard
    // hasn't hydrated yet (e.g. `queue = []` on first load) stick at
    // anchor=null forever and the badge never clears.
    if (!it?.anchor) continue;
    const anchorMs = new Date(it.anchor).getTime();
    if (Number.isNaN(anchorMs) || anchorMs > seenMs) n++;
  }
  return n;
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
