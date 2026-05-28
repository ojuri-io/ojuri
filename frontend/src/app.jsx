// Top-level app — routes between pages, owns shared state.

import React, { useEffect, useState } from 'react';

import { Sidebar, Topbar, computeNotifications, useToasts } from './components/shell.jsx';
import { ErrorBoundary } from './components/error-boundary.jsx';

import {
  listApiKeys,
  listModels,
  listRules,
  listWebhooks,
  listReports,
  me as apiMe,
  logout as apiLogout,
  getReviewQueueCount,
  markNotificationsSeen,
} from './api/client.js';

import Login from './pages/login.jsx';
import ChangePassword from './pages/change-password.jsx';
import Dashboard from './pages/dashboard.jsx';
import LiveDecisions from './pages/live-decisions.jsx';
import TransactionsList from './pages/transactions-list.jsx';
import TransactionDetail from './pages/transaction-detail.jsx';
import ReviewQueue from './pages/review-queue.jsx';
import Investigations from './pages/investigations.jsx';
import AuditLog from './pages/audit-log.jsx';
import RuleEditor from './pages/rule-editor.jsx';
import ModelRegistry from './pages/model-registry.jsx';
import Features from './pages/features.jsx';
import Settings from './pages/settings.jsx';
import Metrics from './pages/metrics.jsx';
import Reports from './pages/reports.jsx';
import ServiceHealth from './pages/service-health.jsx';
import Integrations from './pages/integrations.jsx';
import Users from './pages/users.jsx';
import Roles from './pages/roles.jsx';

function loadRoute() {
  const h = (location.hash || '').replace('#', '') || 'dash';
  if (h.startsWith('txn:')) return { page: 'txn', txn: h.slice(4) };
  const valid = [
    'dash',
    'live',
    'tx',
    'queue',
    'invest',
    'audit',
    'models',
    'features',
    'settings',
    'metrics',
    'reports',
    'health',
    'rules',
    'integ',
    'users',
    'roles',
  ];
  return { page: valid.includes(h) ? h : 'dash', txn: null };
}

function App() {
  // Auth state. `null` = still checking the stored token; an object = logged in;
  // `false` = not logged in (show the Login page).
  const [authUser, setAuthUser] = useState(null);

  // On mount: if we have a stored JWT, validate it against /v1/auth/me.
  // No stored token → straight to login. Bad token → clear it and show login.
  useEffect(() => {
    const stored = (() => {
      try {
        return localStorage.getItem('sentinel.jwt');
      } catch {
        return null;
      }
    })();
    if (!stored) {
      setAuthUser(false);
      return;
    }
    apiMe()
      .then((u) => setAuthUser(u))
      .catch(() => {
        try {
          localStorage.removeItem('sentinel.jwt');
          localStorage.removeItem('sentinel.user');
        } catch {
          /* private window — ignore */
        }
        setAuthUser(false);
      });
  }, []);

  if (authUser === null) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ink-muted)',
          fontSize: 13,
          fontFamily: 'var(--font-body)',
        }}
      >
        Loading…
      </div>
    );
  }

  if (authUser === false) {
    return (
      <Login
        onSuccess={(res) => {
          setAuthUser(res.user);
        }}
      />
    );
  }

  const doLogout = () => {
    try {
      localStorage.removeItem('sentinel.jwt');
      localStorage.removeItem('sentinel.user');
    } catch {
      /* ignore */
    }
    apiLogout().catch(() => {
      /* stateless logout — server response doesn't matter */
    });
    setAuthUser(false);
    location.hash = '';
  };

  // First-login gate. The seeded admin and any user created with a temp
  // password lands here on next sign-in; server middleware refuses every
  // admin endpoint until they rotate. The /auth/change-password and
  // /auth/me routes stay reachable so this flow can complete.
  if (authUser?.mustChangePassword) {
    return (
      <ChangePassword
        user={authUser}
        onSuccess={(refreshed) => {
          // /me returned with the cleared flag — swap in the fresh payload.
          setAuthUser(refreshed);
        }}
        onLogout={doLogout}
      />
    );
  }

  return <AuthenticatedApp user={authUser} onLogout={doLogout} />;
}

// Date stamp shown on the left side of the global topbar. Memoised on
// mount so the label doesn't flicker on every state tick — re-rendering
// daily is enough for an operator workstation.
function todayLabel() {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'short' });
  const monthDay = now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return `Today · ${weekday}, ${monthDay}`;
}

function AuthenticatedApp({ user, onLogout }) {
  const [route, setRoute] = useState(loadRoute());
  const [toastNode, toast] = useToasts();
  const dateLabel = React.useMemo(todayLabel, []);

  // Responsive sidebar drawer. Open state is only meaningful at ≤1024px;
  // when the viewport widens past the breakpoint we auto-close so the
  // backdrop / `aria-hidden` flags don't linger on the now-visible nav.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 1025px)');
    const onChange = (e) => {
      if (e.matches) setDrawerOpen(false);
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // Per-user notification-seen timestamp. Initialised from /auth/me's
  // `lastNotificationSeenAt`; bumped to the server's authoritative now()
  // on every bell open. The Topbar derives the unread-badge count by
  // filtering items whose `anchor` is newer than this. Server failures
  // are non-fatal — the badge will stay set until the next successful
  // open. A pending in-flight mark is debounced so a fast triple-click
  // on the bell only fires one POST.
  const [lastSeenAt, setLastSeenAt] = useState(user.lastNotificationSeenAt || null);
  const markingSeenRef = React.useRef(false);
  const handleMarkSeen = React.useCallback(async () => {
    if (markingSeenRef.current) return;
    markingSeenRef.current = true;
    try {
      const res = await markNotificationsSeen();
      const ts = res?.lastNotificationSeenAt;
      if (ts) setLastSeenAt(ts);
    } catch {
      /* keep prior lastSeenAt; the badge re-fires next open */
    } finally {
      markingSeenRef.current = false;
    }
  }, []);

  // Shared state — all start empty and are hydrated from the API. No
  // mock seeding; an unreachable backend renders the empty state for
  // the page rather than a fake row the operator can't actually action.
  const [queue, setQueue] = useState([]);
  // `queueCount` is the **server-side** total of pending review items
  // (`/v1/admin/audit?pending=1&decision=DECLINE`). We track it
  // separately from `queue.length` because the review-queue endpoint
  // caps at ~100 rows; the local list shrinking after an override
  // doesn't tell us how many remain in the DB. Refreshed on mount, on
  // every override (via `refreshQueueCount`), and on a slow timer.
  const [queueCount, setQueueCount] = useState(null);
  const refreshQueueCount = React.useCallback(async () => {
    const n = await getReviewQueueCount();
    if (typeof n === 'number') setQueueCount(n);
  }, []);
  useEffect(() => {
    refreshQueueCount();
    const t = setInterval(refreshQueueCount, 30_000);
    return () => clearInterval(t);
  }, [refreshQueueCount]);
  const [rules, setRules] = useState([]);
  const [models, setModels] = useState([]);
  const [segmentThresholds, setSegmentThresholds] = useState([]);
  const [reports, setReports] = useState([]);
  // `reportsLive` is `null` while the boot probe hasn't finished, `true`
  // once the FIA call returned, `false` if it errored. The Investigations
  // page renders an "unreachable" banner when this is `false`.
  const [reportsLive, setReportsLive] = useState(null);
  const [apiKeys, setApiKeys] = useState([]);
  const [webhooks, setWebhooks] = useState([]);

  useEffect(() => {
    const onHash = () => setRoute(loadRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Hydration. Live results overwrite local state; when a call fails the
  // safe() wrapper in client.js returns an empty fallback and the per-page
  // empty-state copy tells the operator what to do next.
  //
  // Re-runs when the tab becomes visible again so an operator who registers
  // a model / mints a key / etc. from the CLI (or a second tab) sees it
  // after alt-tabbing back, instead of having to hard-refresh.
  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const [m, r, k, w, rep] = await Promise.all([
        listModels(),
        listRules(),
        listApiKeys(),
        listWebhooks(),
        listReports(),
      ]);
      if (cancelled) return;
      const repReports = (rep && rep.reports) || [];
      const repLive = rep ? !!rep.live : false;
      if (Array.isArray(m)) setModels(m);
      if (Array.isArray(r)) setRules(r);
      if (Array.isArray(k)) setApiKeys(k);
      if (Array.isArray(w)) setWebhooks(w);
      setReports(repReports);
      setReportsLive(repLive);
    };
    hydrate();
    const onVisible = () => {
      if (document.visibilityState === 'visible') hydrate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const nav = (p) => {
    location.hash = p;
    setRoute(loadRoute());
  };

  const { page, txn } = route;
  const navActive = page === 'txn' ? 'tx' : page;

  let PageBody = null;
  let screenLabel = '';
  if (page === 'dash') {
    PageBody = <Dashboard toast={toast} user={user} queue={queue} models={models} reports={reports} webhooks={webhooks} nav={nav} onMarkSeen={handleMarkSeen} />;
    screenLabel = '01 Dashboard';
  } else if (page === 'live') {
    PageBody = <LiveDecisions toast={toast} nav={nav} />;
    screenLabel = '02 Live decisions';
  } else if (page === 'tx') {
    PageBody = <TransactionsList toast={toast} nav={nav} queue={queue} />;
    screenLabel = '03 Transactions';
  } else if (page === 'txn') {
    PageBody = <TransactionDetail toast={toast} user={user} nav={nav} txn={txn} queue={queue} reports={reports} refreshQueueCount={refreshQueueCount} />;
    screenLabel = '03b Transaction detail';
  } else if (page === 'queue') {
    PageBody = <ReviewQueue toast={toast} nav={nav} queue={queue} setQueue={setQueue} queueCount={queueCount} refreshQueueCount={refreshQueueCount} />;
    screenLabel = '04 Review queue';
  } else if (page === 'invest') {
    PageBody = (
      <Investigations
        toast={toast}
        nav={nav}
        reports={reports}
        setReports={setReports}
        reportsLive={reportsLive}
        setReportsLive={setReportsLive}
      />
    );
    screenLabel = '05 Investigations';
  } else if (page === 'audit') {
    PageBody = <AuditLog toast={toast} nav={nav} queue={queue} rules={rules} />;
    screenLabel = '06 Audit log';
  } else if (page === 'models') {
    PageBody = (
      <ModelRegistry
        toast={toast}
        models={models}
        setModels={setModels}
        segmentThresholds={segmentThresholds}
        setSegmentThresholds={setSegmentThresholds}
        user={user}
      />
    );
    screenLabel = '07 Models';
  } else if (page === 'features') {
    PageBody = <Features toast={toast} />;
    screenLabel = '07a Features';
  } else if (page === 'settings') {
    PageBody = <Settings toast={toast} user={user} />;
    screenLabel = '07b Settings';
  } else if (page === 'metrics') {
    PageBody = <Metrics toast={toast} />;
    screenLabel = '08 Metrics';
  } else if (page === 'reports') {
    PageBody = <Reports toast={toast} user={user} />;
    screenLabel = '08a Reports';
  } else if (page === 'health') {
    PageBody = <ServiceHealth toast={toast} />;
    screenLabel = '09 System health';
  } else if (page === 'rules') {
    PageBody = <RuleEditor toast={toast} rules={rules} setRules={setRules} user={user} />;
    screenLabel = '10 Rules';
  } else if (page === 'integ') {
    PageBody = (
      <Integrations
        toast={toast}
        apiKeys={apiKeys}
        setApiKeys={setApiKeys}
        webhooks={webhooks}
        setWebhooks={setWebhooks}
        deliveries={[]}
        user={user}
      />
    );
    screenLabel = '11 Integrations';
  } else if (page === 'users') {
    PageBody = <Users toast={toast} currentUser={user} user={user} />;
    screenLabel = '12 Users';
  } else if (page === 'roles') {
    PageBody = <Roles toast={toast} user={user} />;
    screenLabel = '13 Roles';
  }

  // Bell notifications are sourced from the same state the dashboard
  // surfaces — so the badge count and the dashboard's "Things to do"
  // never disagree.
  const notifications = computeNotifications({
    queueCount,
    queue,
    reports,
    models,
    webhooks,
    nav,
  });

  return (
    <div className="app">
      <Sidebar
        active={navActive}
        onNav={nav}
        queueCount={typeof queueCount === 'number' ? queueCount : queue.length}
        user={user}
        mobileOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      <div className="main">
        <Topbar
          dateLabel={dateLabel}
          notifications={notifications}
          user={user}
          onLogout={onLogout}
          onMenuClick={() => setDrawerOpen((o) => !o)}
          lastSeenAt={lastSeenAt}
          onMarkSeen={handleMarkSeen}
        />
        <div className="main-scroll">
          <div className="page-shell" data-screen-label={screenLabel}>
            {/* `resetKey` lets the boundary auto-recover when the user
                navigates away from the page that threw. Without it, a
                single bad render would keep the fallback shown across
                page changes. */}
            <ErrorBoundary resetKey={page + (txn || '')}>
              {PageBody}
            </ErrorBoundary>
          </div>
        </div>
      </div>
      {toastNode}
    </div>
  );
}

export default App;
