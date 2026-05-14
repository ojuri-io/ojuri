# Sentinel — fraud-ops dashboard

Front-end for the multi-agent fraud-detection stack in this repo. Implements
the **Sentinel.html** design handed off from Claude Design (see
`/tmp/sentinel-design/` if you still have the bundle, or the screenshots in
`docs/`). One page per file under `src/pages/`, shared chrome under
`src/components/`, API client under `src/api/`.

## Layout

```
frontend/
  index.html
  vite.config.js
  package.json
  src/
    main.jsx              # React 18 root
    app.jsx               # routing + shared state + tweaks panel
    styles.css            # design tokens, sidebar, panels, pills, modals
    api/client.js         # /v1 (RDA) + /fia (FIA) calls with mock fallback
    components/
      shell.jsx           # Ti, Sidebar, PageHead, Modal, useToasts, helpers
      tweaks-panel.jsx    # floating tweak controls (accent / density / dark)
    data/mock.js          # seed data so the dashboard demos offline
    pages/
      dashboard.jsx
      live-decisions.jsx
      transactions-list.jsx
      transaction-detail.jsx
      review-queue.jsx
      investigations.jsx
      audit-log.jsx
      rule-editor.jsx
      model-registry.jsx
      metrics.jsx
      service-health.jsx
      integrations.jsx
  tests/
    setup.js
    helpers.test.js       # fmtNaira / fmtAge / ageTone / truncId
    sidebar.test.jsx      # nav rendering + click routing
    app.test.jsx          # landing render + hash navigation
    api-client.test.js    # safe() + fallback paths
```

## Running

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
npm run build        # → dist/
npm test             # vitest run
```

The dev server proxies:

- `/v1/*` → `VITE_RDA_URL` (default `http://localhost:3000`) — RDA HTTP API.
- `/fia/*` → `VITE_FIA_URL` (default `http://localhost:9094`), prefix stripped
  — FIA HTTP API for on-demand reports and conversational follow-ups.

## Auth

Admin-gated endpoints (`/v1/admin/...`) require a logged-in user JWT
(`Authorization: Bearer …`). Get one with the seeded admin:

```bash
curl -X POST http://localhost:3000/v1/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"admin@fraudit"}'
```

Then store the token in the browser:

```js
localStorage.setItem('sentinel.jwt', '<token from the response>');
```

The `/v1/predict` endpoint accepts an `x-api-key` header (a token
issued via `POST /v1/admin/api-keys`, format `fdk_<prefix>_<secret>`):

```js
localStorage.setItem('sentinel.apiKey', 'fdk_…');
```

Full auth model: [`../docs/AUTHZ.md`](../docs/AUTHZ.md).

## Offline / demo mode

Every API call in `src/api/client.js` is wrapped in `safe()`. If the
backing service is unreachable (network error, 401, 500) the call returns
the corresponding slice of `src/data/mock.js` so the design can be
demoed without the full stack running. Force the mock path explicitly
with:

```js
localStorage.setItem('sentinel.useMock', '1');
```

## Tests

`npm test` runs the Vitest suite in jsdom: smoke tests for the shell
helpers, the sidebar's active-state and click behaviour, the App-level
routing, and the API client's fallback behaviour. 16 tests; runs in
~1.3s on a 2024 MBP.
