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
| `/v1/*`     | `VITE_RDA_URL`   | `http://127.0.0.1:3000`  | RDA     |
| `/fia/*`    | `VITE_FIA_URL`   | `http://127.0.0.1:9094`  | FIA (prefix stripped) |

Those defaults apply when the variable is unset. `frontend/.env.example`
ships with the Docker-stack values (`http://localhost`) active instead,
so copying it unchanged works for the compose quickstart; switch to the
commented `127.0.0.1` block for host-side development.

The proxy lets the SPA call same-origin URLs in dev so CORS isn't a
concern.

### Deploying it

`npm run dev` is a development server — don't ship it. For a real
deployment use the published image:

```bash
docker run -p 8080:80 ghcr.io/ojuri-io/sentinel:v1
```

It is the built SPA served by nginx on port 80, with HTML5-history
fallback so client-side routes survive a hard refresh. It carries **no
API proxy of its own** — the dev-server proxy in the table above does not
exist in this image. Front it with your own ingress and route `/v1/*` to
RDA and `/fia/*` to FIA, or mount your own config over
`/etc/nginx/conf.d/default.conf`.

Watch for one failure mode when wiring that up: because the history
fallback answers every unmatched path with `index.html`, an unrouted
`/v1/predict` returns **HTTP 200 with HTML**, not a 404. If the dashboard
loads but every panel is empty, check that your ingress is routing the
API prefixes before assuming the backend is down.

The image is not part of `docker-compose.yml`, where NGINX already binds
port 80. Building it yourself is `docker build -t sentinel frontend/`.

## Pages

Every read renders an **empty-state** when the backend is unreachable or you
haven't logged in. The dashboard never displays synthetic data; see
"Offline behaviour" below.

| Route hash    | Page              | Backed by                                                                 |
|---------------|-------------------|---------------------------------------------------------------------------|
| `#dash`       | Dashboard         | `/v1/admin/models` champion + audit summary; empty state on 401/offline   |
| `#live`       | Live decisions    | client-side simulator (placeholder for SSE / WebSocket subscription)      |
| `#tx`         | Transactions list | audit log read; empty state on 401/offline                                |
| `#txn:<uuid>` | Transaction detail| audit row + FIA follow-up via `/fia/v1/reports/:id/messages`              |
| `#queue`      | Review queue      | audit-log filter for `REVIEW` decisions; override → `/v1/decisions/:auditId/override` |
| `#invest`     | Investigations    | `/fia/v1/reports`, `POST /fia/v1/reports`, `POST /fia/v1/reports/:id/messages` |
| `#audit`      | Audit log         | `/v1/admin/audit?from=&to=`                                                |
| `#rules`      | Rule editor       | `/v1/admin/rules` GET / POST / PUT / DELETE                               |
| `#models`     | Model registry    | `/v1/admin/models` GET / POST, `/v1/admin/models/:version/status` PATCH    |
| `#metrics`    | Metrics           | `/v1/metrics` Prometheus scrape parser                                    |
| `#health`     | System health     | `/livez` + `/readyz` fan-out                                              |
| `#integ`      | Integrations      | `/v1/admin/api-keys` + `/v1/admin/webhooks`                               |

Routes that call `/v1/admin/*` return an empty fallback (`[]` or
`{ rows: [], total: 0 }`) when `sentinel.jwt` is unset or the backend
401s — the page renders its empty state. Writes will 401 until you log in.

## Auth

Two pieces of state live in `localStorage`:

| Key               | Sent as                       | When required                                |
|-------------------|-------------------------------|----------------------------------------------|
| `sentinel.jwt`    | `Authorization: Bearer <…>`   | Any call under `/v1/admin/*` and `/v1/auth/me`|
| `sentinel.apiKey` | `X-Api-Key: <…>`              | `/v1/predict` and other key-gated endpoints  |

Get the JWT by calling `POST /v1/auth/login` with the seeded `admin` user —
the password is **printed once by `npm run db:migrate`** at the repo root;
copy it from the migration output (see [`AUTHZ.md`](AUTHZ.md)):

```bash
curl -X POST http://localhost:3000/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"<from migration output>"}'
```

Then store the token in DevTools and reload:

```js
localStorage.setItem('sentinel.jwt', '<token>');
localStorage.setItem('sentinel.apiKey', 'fdk_…');
```

Tokens never leave the browser; JWT sessions are stateless on the
server side and expire on `AUTH_JWT_TTL_SECONDS` (default 8 h).

## Offline behaviour

`src/api/client.js` wraps every read call in `safe(live, fallback)`:

```js
export async function safe(live, fallback) {
  try { return await live(); }
  catch (err) {
    console.warn('[sentinel] API call failed, using empty fallback:', err.message);
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}
```

`fallback` is **always an empty value** — `[]`, `{ rows: [], total: 0 }`,
`null` — supplied by the caller. When RDA or FIA is unreachable the
dashboard renders empty states with the per-page empty-state copy and
shows a persistent `OFFLINE` banner from `app.jsx`. It **never displays
synthetic data**. The seed dataset (`src/data/mock.js`) and the
`sentinel.useMock` localStorage override were removed in May 2026 —
adopters were confused by fake credentials, fake fraud rows, and a
fully-populated Integrations tab showing up the moment the backend
was unreachable.

Write calls (issue key, save rule, register model, override decision,
…) do **not** go through `safe`. They `try` the real call, catch
failures locally, surface a toast, and leave the form in its previous
state so the operator can retry. No optimistic local-state mutation,
no silent success.

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
| `tests/api-client.test.js`      | `safe()` happy path + empty-fallback on failure        |

16 tests; ~1.3s total on a 2024 MBP. Add to the matrix when you wire
a new endpoint — every page that calls `/v1/admin/*` should have at
least a fallback test so the UI doesn't break when adopters run
without an admin token.

## Extending it

A few common adoption tasks:

- **Wire a new admin endpoint** — add the client helper in
  `src/api/client.js` wrapped in `safe(live, [])` (or whatever empty
  fallback shape the page expects), then call it from the page. Reads
  must never fall back to synthetic data; if the call fails the page
  renders its empty state.
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
