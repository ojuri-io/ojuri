// Top-level app — routes between pages, owns shared state, hosts the Tweaks panel.

import React, { useEffect, useMemo, useState } from 'react';

import { Sidebar, useToasts, Ti } from './components/shell.jsx';
import { ErrorBoundary } from './components/error-boundary.jsx';
import {
  TweaksPanel,
  TweakSection,
  TweakToggle,
  TweakColor,
  TweakRadio,
  TweakButton,
  TwkDate,
  useTweaks,
} from './components/tweaks-panel.jsx';

import { MOCK } from './data/mock.js';
import {
  listApiKeys,
  listModels,
  listRules,
  listWebhooks,
  listReports,
  me as apiMe,
  logout as apiLogout,
  getReviewQueueCount,
} from './api/client.js';

import Login from './pages/login.jsx';
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
import Metrics from './pages/metrics.jsx';
import Reports from './pages/reports.jsx';
import ServiceHealth from './pages/service-health.jsx';
import Integrations from './pages/integrations.jsx';
import Users from './pages/users.jsx';
import Roles from './pages/roles.jsx';

const TWEAK_DEFAULTS = {
  from: '2026-05-06T16:22',
  to: '2026-05-13T16:22',
  accent: '#1b8a52',
  density: 'regular',
  dark: false,
};

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

// Convert hex to a tint at the given lightness. In light mode mixes toward
// white, in dark mode toward near-black so the tint reads as a subtle backdrop.
function hexToTint(hex, lightness, dark = false) {
  const m = hex.replace('#', '').match(/.{2}/g);
  if (!m) return hex;
  const [r, g, b] = m.map((x) => parseInt(x, 16));
  const tgt = dark ? [24, 24, 27] : [255, 255, 255];
  const mix = (c, t) => Math.round(c + (t - c) * lightness);
  return `rgb(${mix(r, tgt[0])}, ${mix(g, tgt[1])}, ${mix(b, tgt[2])})`;
}

function nowLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
}
function lastNHours(h) {
  const d = new Date(Date.now() - h * 3600 * 1000);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
}

function App() {
  // Auth state. `null` = still checking the stored token; an object = logged in;
  // `false` = not logged in (show the Login page).
  const [authUser, setAuthUser] = useState(null);
  // Connection status for the mock/live banner. 'live' = /v1/auth/me succeeded;
  // 'mock' = at least one hydration call fell back to seed data; 'checking' = boot.
  const [connection, setConnection] = useState('checking');

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
          color: 'var(--color-text-tertiary)',
          fontSize: 12,
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
          setConnection('live');
        }}
      />
    );
  }

  return (
    <AuthenticatedApp
      user={authUser}
      connection={connection}
      setConnection={setConnection}
      onLogout={() => {
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
      }}
    />
  );
}

function AuthenticatedApp({ user, connection, setConnection, onLogout }) {
  const [route, setRoute] = useState(loadRoute());
  const [toastNode, toast] = useToasts();
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Shared state — seeded from mocks, then patched from the API in the background.
  const [queue, setQueue] = useState(MOCK.queue);
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
  const [rules, setRules] = useState(MOCK.rules);
  // Models and per-segment thresholds are DB-backed; no seed fallback.
  // The Models page starts empty and is hydrated by the boot effect
  // (`listModels`) and the page's own `listSegmentThresholds` call.
  const [models, setModels] = useState([]);
  const [segmentThresholds, setSegmentThresholds] = useState([]);
  const [reports, setReports] = useState(MOCK.reports);
  // `reportsLive` is `null` while the boot probe hasn't finished, `true`
  // once the FIA call returned, `false` if it errored. The Investigations
  // page uses this to choose between an empty-state and the seed-data
  // design preview.
  const [reportsLive, setReportsLive] = useState(null);
  const [apiKeys, setApiKeys] = useState(MOCK.apiKeys);
  const [webhooks, setWebhooks] = useState(MOCK.webhooks);

  useEffect(() => {
    const onHash = () => setRoute(loadRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Hydration. We track whether *any* read came back from the live API
  // (vs the safe() fallback) so the mock/live banner is accurate. The
  // `client.js` `safe()` wrapper swallows errors and returns MOCK; here
  // we re-fetch the bare endpoint just to learn the HTTP status.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const probe = await fetch('/v1/admin/rules', {
        headers: { authorization: `Bearer ${localStorage.getItem('sentinel.jwt') || ''}` },
      }).catch(() => null);
      if (cancelled) return;
      setConnection(probe && probe.ok ? 'live' : 'mock');

      const [m, r, k, w, rep] = await Promise.all([
        listModels(),
        listRules(),
        listApiKeys(),
        listWebhooks(),
        listReports(),
      ]);
      if (cancelled) return;
      // Strict overwrite: when the live API returns an array — including an
      // empty one — that's the truth. The seed mocks only stick if the call
      // failed and `safe()` returned the mock. The mock/live banner above
      // tells the user which mode they're in.
      const isLive = probe && probe.ok;
      // listReports returns { reports, live } so the Investigations page
      // can distinguish "FIA returned 0 rows" from "FIA unreachable".
      const repReports = (rep && rep.reports) || [];
      const repLive = rep ? !!rep.live : false;
      if (isLive) {
        if (Array.isArray(m)) setModels(m);
        if (Array.isArray(r)) setRules(r);
        if (Array.isArray(k)) setApiKeys(k);
        if (Array.isArray(w)) setWebhooks(w);
        // Always trust the FIA call's own live flag — RDA being live
        // doesn't imply FIA is reachable (different service).
        setReports(repReports);
        setReportsLive(repLive);
      } else {
        if (Array.isArray(m) && m.length) setModels(m);
        if (Array.isArray(r) && r.length) setRules(r);
        if (Array.isArray(k) && k.length) setApiKeys(k);
        if (Array.isArray(w) && w.length) setWebhooks(w);
        // FIA fell back — keep seeded design preview but flag it as not-live.
        if (!repLive) {
          setReports(MOCK.reports);
          setReportsLive(false);
        } else {
          setReports(repReports);
          setReportsLive(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setConnection]);

  const nav = (p) => {
    location.hash = p;
    setRoute(loadRoute());
  };

  const { page, txn } = route;
  const navActive = page === 'txn' ? 'tx' : page;

  const accentVars = useMemo(() => {
    const tint = hexToTint(t.accent, 0.92, t.dark);
    const border = hexToTint(t.accent, 0.6, t.dark);
    return {
      '--color-text-info': t.accent,
      '--color-background-info': tint,
      '--color-border-info': border,
    };
  }, [t.accent, t.dark]);

  const densityVars =
    t.density === 'compact'
      ? { '--row-pad-y': '6px', '--font-base': '12px' }
      : t.density === 'comfy'
      ? { '--row-pad-y': '12px', '--font-base': '14px' }
      : { '--row-pad-y': '9px', '--font-base': '13px' };

  let PageBody = null;
  let screenLabel = '';
  if (page === 'dash') {
    PageBody = <Dashboard toast={toast} queue={queue} models={models} reports={reports} webhooks={webhooks} nav={nav} />;
    screenLabel = '01 Dashboard';
  } else if (page === 'live') {
    PageBody = <LiveDecisions toast={toast} nav={nav} />;
    screenLabel = '02 Live decisions';
  } else if (page === 'tx') {
    PageBody = <TransactionsList toast={toast} nav={nav} queue={queue} />;
    screenLabel = '03 Transactions';
  } else if (page === 'txn') {
    PageBody = <TransactionDetail toast={toast} nav={nav} txn={txn} queue={queue} reports={reports} refreshQueueCount={refreshQueueCount} />;
    screenLabel = '03b Transaction detail';
  } else if (page === 'queue') {
    PageBody = <ReviewQueue toast={toast} nav={nav} queue={queue} setQueue={setQueue} queueCount={queueCount} refreshQueueCount={refreshQueueCount} />;
    screenLabel = '04 Review queue';
  } else if (page === 'invest') {
    PageBody = (
      <Investigations
        toast={toast}
        reports={reports}
        setReports={setReports}
        reportsLive={reportsLive}
        setReportsLive={setReportsLive}
      />
    );
    screenLabel = '05 Investigations';
  } else if (page === 'audit') {
    PageBody = <AuditLog toast={toast} nav={nav} queue={queue} rules={rules} fromTweak={t.from} toTweak={t.to} />;
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
        deliveries={MOCK.deliveries}
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

  return (
    <div className="app" data-theme={t.dark ? 'dark' : 'light'} style={{ ...accentVars, ...densityVars }}>
      <Sidebar
        active={navActive}
        onNav={nav}
        queueCount={typeof queueCount === 'number' ? queueCount : queue.length}
        user={user}
        onLogout={onLogout}
      />
      <div className="main">
        <ConnectionBanner connection={connection} />
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

      <TweaksPanel title="Tweaks">
        <TweakSection label="Audit range" />
        <TwkDate label="From" value={t.from} onChange={(v) => setTweak('from', v)} />
        <TwkDate label="To" value={t.to} onChange={(v) => setTweak('to', v)} />
        <TweakButton
          label="Last 24h"
          onClick={() => {
            setTweak({ from: lastNHours(24), to: nowLocal() });
            toast('Range → last 24h');
          }}
        />
        <TweakButton
          label="Last 7d"
          onClick={() => {
            setTweak({ from: lastNHours(24 * 7), to: nowLocal() });
            toast('Range → last 7d');
          }}
        />

        <TweakSection label="Theme" />
        <TweakToggle label="Dark mode" value={t.dark} onChange={(v) => setTweak('dark', v)} />
        <TweakColor
          label="Accent"
          value={t.accent}
          options={['#3a55d3', '#1b8a52', '#a76b08', '#c0364a', '#7a5ae0', '#1c1c1f']}
          onChange={(v) => setTweak('accent', v)}
        />
        <TweakRadio
          label="Density"
          value={t.density}
          options={['compact', 'regular', 'comfy']}
          onChange={(v) => setTweak('density', v)}
        />
      </TweaksPanel>
    </div>
  );
}

function ConnectionBanner({ connection }) {
  if (connection === 'live') {
    return (
      <div
        title="Reads are coming from the live RDA backend"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          fontSize: 11,
          background: 'var(--color-background-success)',
          color: 'var(--color-text-success)',
          borderBottom: '0.5px solid var(--color-border-success)',
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--color-text-success)',
          }}
        />
        <b style={{ fontWeight: 500 }}>LIVE</b>
        <span style={{ color: 'inherit', opacity: 0.85 }}>
          Connected to the RDA backend — data shown is from the database.
        </span>
      </div>
    );
  }
  if (connection === 'mock') {
    return (
      <div
        title="The RDA backend is unreachable or unauthorised — pages are showing seeded mock data"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          fontSize: 11,
          background: 'var(--color-background-warning)',
          color: 'var(--color-text-warning)',
          borderBottom: '0.5px solid var(--color-border-warning)',
        }}
      >
        <Ti name="alert-triangle" size={11} />
        <b style={{ fontWeight: 500 }}>MOCK</b>
        <span style={{ color: 'inherit', opacity: 0.85 }}>
          RDA admin reads failed — using seeded fallback data. Writes will be
          reflected locally but will not hit the database.
        </span>
      </div>
    );
  }
  // 'checking' — render nothing rather than flash a status that's about to change.
  return null;
}

export default App;
