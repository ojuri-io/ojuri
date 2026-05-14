# Sentinel Dashboard (frontend)

Operator UI for the multi-agent fraud-detection platform. Built from
the Sentinel design handoff (`Sentinel.html` and its 13 page modules)
and shipped as a Vite + React 18 SPA under `frontend/`.

The dashboard is **read-mostly with selective writes**: it never sits
on the real-time prediction hot path. Writes (issue API key, save
rule, register model, subscribe webhook, request investigation
report) go to the RDA `/v1/admin/*` surface and FIA `/v1/reports*`
endpoints documented in [`AUTH.md`](AUTH.md), [`RULES.md`](RULES.md),
[`MODEL-REGISTRY.md`](MODEL-REGISTRY.md), [`WEBHOOKS.md`](WEBHOOKS.md),
and [`FIA-API.md`](FIA-API.md).

## Running

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
npm run build        # → dist/
npm test             # Vitest run
```

`npm run dev` proxies API calls:

| Path prefix | Target env var   | Default                  | Service |
|-------------|------------------|--------------------------|---------|
| `/v1/*`     | `VITE_RDA_URL`   | `http://localhost:3000`  | RDA     |
| `/fia/*`    | `VITE_FIA_URL`   | `http://localhost:9094`  | FIA (prefix stripped) |

The proxy lets the SPA call same-origin URLs in dev so CORS isn't a
concern. In production builds, set those env vars at build time or
serve the SPA behind your existing reverse proxy.

## Pages

| Route hash    | Page              | Backed by                                                                 |
|---------------|-------------------|---------------------------------------------------------------------------|
| `#dash`       | Dashboard         | mock + champion model from `/v1/admin/models`                             |
| `#live`       | Live decisions    | client-side simulator (placeholder for SSE / WebSocket subscription)      |
| `#tx`         | Transactions list | mock + queue state                                                        |
| `#txn:<uuid>` | Transaction detail| derived from queue state + FIA follow-up via `/fia/v1/reports/:id/messages` |
| `#queue`      | Review queue      | mock state; override hits `/v1/decisions/:auditId/override` (planned)     |
| `#invest`     | Investigations    | `/fia/v1/reports`, `POST /fia/v1/reports`, `POST /fia/v1/reports/:id/messages` |
| `#audit`      | Audit log         | mock (planned: `/v1/admin/audit?from=&to=`)                               |
| `#rules`      | Rule editor       | `/v1/admin/rules` GET / POST / PUT / DELETE                               |
| `#models`     | Model registry    | `/v1/admin/models` GET / POST, `/v1/admin/models/:version/status` PATCH    |
| `#metrics`    | Metrics           | mock (planned: `/v1/metrics` Prometheus scrape parser)                    |
| `#health`     | System health     | mock (planned: `/livez` + `/readyz` fan-out)                              |
| `#integ`      | Integrations      | `/v1/admin/api-keys` + `/v1/admin/webhooks`                               |

Routes that read from `/v1/admin/*` will return mock data on first
load if you haven't set `sentinel.jwt` yet — the dashboard stays
functional, but writes will 401 until you log in.

## Auth

Two pieces of state live in `localStorage`:

| Key               | Sent as                       | When required                                |
|-------------------|-------------------------------|----------------------------------------------|
| `sentinel.jwt`    | `Authorization: Bearer <…>`   | Any call under `/v1/admin/*` and `/v1/auth/me`|
| `sentinel.apiKey` | `X-Api-Key: <…>`              | `/v1/predict` and other key-gated endpoints  |

Get the JWT by calling `POST /v1/auth/login` with seed credentials
`admin / admin@fraudit` (see [`AUTHZ.md`](AUTHZ.md)):

```bash
curl -X POST http://localhost:3000/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"admin@fraudit"}'
```

Then store the token in DevTools and reload:

```js
localStorage.setItem('sentinel.jwt', '<token>');
localStorage.setItem('sentinel.apiKey', 'fdk_…');
```

Tokens never leave the browser; JWT sessions are stateless on the
server side and expire on `AUTH_JWT_TTL_SECONDS` (default 8 h).

## Offline / demo mode

`src/api/client.js` wraps every read call in `safe(live, fallback)`:

```js
export async function safe(live, fallback) {
  if (useMockOverride()) return await fallback();
  try { return await live(); }
  catch (err) { return await fallback(); }
}
```

`fallback` is always the corresponding slice of `src/data/mock.js`
(the dataset baked into the design). When the RDA or FIA services
aren't running, the dashboard silently uses the seed data and the
console emits `[sentinel] API call failed, using mock fallback: …`
once per failed call. Write calls (issue key, save rule, …) catch
their own failures and update local React state so the UI keeps
responding even with the backend down — the change just isn't
persisted server-side.

Force the mock path explicitly (useful when the API is up but you
want a deterministic dataset for screenshots):

```js
localStorage.setItem('sentinel.useMock', '1');
```

Unset to resume live calls:

```js
localStorage.removeItem('sentinel.useMock');
```

## Tweaks panel

The floating ⚙ Tweaks panel in the bottom-right of every page
exposes:

- **Audit range** — `from` / `to` datetime pickers + Last-24h /
  Last-7d shortcuts. Wires into the Audit log filters.
- **Theme** — Dark mode toggle, accent colour picker (six presets),
  density radio (compact / regular / comfy). Themes apply via CSS
  custom properties on the app root, so any future page picks them
  up for free.

Settings live in React state only — they reset on reload. Persisting
them is a one-liner if/when adopters want it.

## Project layout

```
frontend/
├── index.html
├── vite.config.js                # /v1 + /fia proxy, Vitest config
├── package.json
├── tests/
│   ├── setup.js                  # jest-dom, ResizeObserver stub
│   ├── helpers.test.js
│   ├── sidebar.test.jsx
│   ├── app.test.jsx
│   └── api-client.test.js
└── src/
    ├── main.jsx                  # React 18 root
    ├── app.jsx                   # hash routing, shared state, tweaks panel
    ├── styles.css                # design tokens + sidebar + panels + pills
    ├── api/client.js             # safe() + every endpoint wrapper
    ├── data/mock.js              # seed dataset (offline fallback)
    ├── components/
    │   ├── shell.jsx             # Sidebar, PageHead, Modal, Ti, useToasts, helpers
    │   └── tweaks-panel.jsx
    └── pages/
        ├── dashboard.jsx
        ├── live-decisions.jsx
        ├── transactions-list.jsx
        ├── transaction-detail.jsx
        ├── review-queue.jsx
        ├── investigations.jsx
        ├── audit-log.jsx
        ├── rule-editor.jsx
        ├── model-registry.jsx
        ├── metrics.jsx
        ├── service-health.jsx
        └── integrations.jsx
```

## Tests

`npm test` (Vitest in jsdom) runs four suites:

| File                            | Covers                                                 |
|---------------------------------|--------------------------------------------------------|
| `tests/helpers.test.js`         | `fmtNaira` / `fmtAge` / `ageTone` / `truncId`          |
| `tests/sidebar.test.jsx`        | Nav rendering, active state, queue badge tone, clicks   |
| `tests/app.test.jsx`            | Landing render, hash routing, sidebar brand            |
| `tests/api-client.test.js`      | `safe()` happy path + fallback, `useMock` override     |

16 tests; ~1.3s total on a 2024 MBP. Add to the matrix when you wire
a new endpoint — every page that calls `/v1/admin/*` should have at
least a fallback test so the UI doesn't break when adopters run
without an admin token.

## Extending it

A few common adoption tasks:

- **Wire the audit log to the real endpoint** — replace the synthetic
  rows in `pages/audit-log.jsx` (`buildAuditRows`) with a call to a
  new `listAuditLog` client helper. Mirror the `safe()` + fallback
  pattern.
- **Stream live decisions** — `pages/live-decisions.jsx` runs a local
  `setInterval` simulator. Swap it for an `EventSource` against an
  SSE endpoint on RDA (or a WebSocket on a sidecar) when you add
  one. The decision-pill colour logic in `decisionToneClass` is
  shared, so the new stream just needs to push rows matching the
  same shape.
- **Add a page** — drop a new module under `src/pages/`, default-export
  the component, add the route id to `loadRoute()` in `app.jsx`, then
  add a `Sidebar` entry under the appropriate section in
  `components/shell.jsx`.
- **Change theme tokens** — `src/styles.css` owns every colour /
  border / radius / shadow variable. The Tweaks panel writes to a
  subset of those at runtime; everything else is static.
