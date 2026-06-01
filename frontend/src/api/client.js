// API client for the Sentinel dashboard.
//
// Talks to the RDA HTTP API (root `/v1`) for admin resources, and to
// the FIA HTTP API (root `/fia`) for investigation reports / messages.
// Both paths are proxied in development by `vite.config.js`.
//
// No mock fallback — when a call fails, `safe()` returns the empty
// fallback the caller supplied (typically `[]` or `null`). The per-
// page empty-state copy explains what's missing; we never paper over
// an unreachable backend with fake rows the operator can't action.

const getJwt = () => {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('sentinel.jwt')) || '';
  } catch {
    return '';
  }
};

const getApiKey = () => {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('sentinel.apiKey')) || '';
  } catch {
    return '';
  }
};

/**
 * Headers for admin requests. By default sets `content-type:
 * application/json` because most callers ship a JSON body. Pass
 * `{ body: false }` for DELETE / GET-with-no-body — Fastify's JSON
 * parser throws 400 on an empty body when content-type is application/
 * json, which silently broke every delete-style request in the UI.
 */
const adminHeaders = ({ body = true } = {}) => {
  const h = {};
  if (body) h['content-type'] = 'application/json';
  const t = getJwt();
  if (t) h['authorization'] = `Bearer ${t}`;
  return h;
};

const apiHeaders = () => {
  const h = { 'content-type': 'application/json' };
  const k = getApiKey();
  if (k) h['x-api-key'] = k;
  return h;
};

const unwrap = async (res) => {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  const json = await res.json();
  // RDA wraps responses in `{ success, message, data }`; tolerate both shapes.
  return json && typeof json === 'object' && 'data' in json ? json.data : json;
};

/**
 * Run `live` against the real API. If it throws (network down, 401, etc.)
 * fall back to `fallback`. Exposed so individual pages can opt in.
 */
export async function safe(live, fallback) {
  try {
    return await live();
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[sentinel] API call failed, using empty fallback:', err.message);
    }
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

// ──────── Auth ────────
export const login = ({ username, password, tenantId }) =>
  fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, tenantId }),
  }).then(unwrap);

export const logout = () =>
  fetch('/v1/auth/logout', { method: 'POST', headers: adminHeaders({ body: false }) }).then(unwrap);

export const me = () => fetch('/v1/auth/me', { headers: adminHeaders() }).then(unwrap);

// Rotate the caller's own password. Used by the forced-change screen
// for the seed admin on first login and by any user the backend has
// flagged with `mustChangePassword=true`. Server-side enforcement at
// `denyIfPasswordRotation` middleware returns 423 for every other
// admin route until this succeeds.
export const changePassword = ({ currentPassword, newPassword }) =>
  fetch('/v1/auth/change-password', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ currentPassword, newPassword }),
  }).then(unwrap);

// Stamp the authenticated user's `lastNotificationSeenAt` to now.
// Called when the bell popover opens. Server returns the new ISO
// timestamp; the caller swaps it into local state so the badge count
// recomputes on the next render. Failures are non-fatal — the badge
// will just stay set until the next successful open.
export const markNotificationsSeen = () =>
  fetch('/v1/notifications/seen', {
    method: 'POST',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

// ──────── Users (admin) ────────
// Always paginated: returns `{ rows, total }`. Server-side search
// across username / fullName / email. The backing table can grow, so
// unparameterised reads are not supported.
export const listUsers = ({ limit = 25, offset = 0, search = '' } = {}) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));
  if (search) qs.set('search', search);
  return safe(
    () => fetch(`/v1/admin/users?${qs.toString()}`, { headers: adminHeaders() }).then(unwrap),
    () => ({ rows: [], total: 0 }),
  );
};

export const createUser = (body) =>
  fetch('/v1/admin/users', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  }).then(unwrap);

export const updateUser = (id, body) =>
  fetch(`/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  }).then(unwrap);

export const deleteUser = (id) =>
  fetch(`/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

export const assignUserRole = (userId, roleId) =>
  fetch(`/v1/admin/users/${encodeURIComponent(userId)}/roles`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ roleId }),
  }).then(unwrap);

export const unassignUserRole = (userId, roleId) =>
  fetch(
    `/v1/admin/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    { method: 'DELETE', headers: adminHeaders({ body: false }) },
  ).then(unwrap);

// ──────── Roles + Permissions (admin) ────────
export const listRoles = () =>
  safe(() => fetch('/v1/admin/roles', { headers: adminHeaders() }).then(unwrap), () => []);

export const listPermissions = () =>
  safe(
    () => fetch('/v1/admin/permissions', { headers: adminHeaders() }).then(unwrap),
    () => [],
  );

export const createRole = (body) =>
  fetch('/v1/admin/roles', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  }).then(unwrap);

export const updateRole = (id, body) =>
  fetch(`/v1/admin/roles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  }).then(unwrap);

export const deleteRole = (id) =>
  fetch(`/v1/admin/roles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

// ──────── Predict (RDA) ────────
export const predict = (payload) =>
  fetch('/v1/predict', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(payload),
  }).then(unwrap);

// Reads return null on offline/401 — every other safe() fallback in
// this file returns an empty value (`[]`, `{ rows: [], total: 0 }`).
// The previous realistic-looking placeholders (47 dec/s, 7.8% decline)
// misled operators into thinking the system was running when RDA was
// down; per docs/FRONTEND.md the dashboard never displays synthetic data.
export const metrics = () =>
  safe(() => fetch('/v1/metrics', { headers: adminHeaders({ body: false }) }).then(unwrap), null);

// ──────── API keys (admin) ────────
export const listApiKeys = () =>
  safe(
    () =>
      fetch('/v1/admin/api-keys', { headers: adminHeaders() })
        .then(unwrap)
        .then((rows) =>
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            prefix: r.prefix || `fdk_${r.id.slice(0, 12)}_`,
            scope: r.scope,
            rateLimit: r.rateLimitPerMinute ?? null,
            lastUsed: r.lastUsedAt
              ? new Date(r.lastUsedAt).toLocaleString()
              : 'never',
            expires: r.expiresAt
              ? new Date(r.expiresAt).toLocaleDateString()
              : 'no expiry',
            status: r.revokedAt ? 'revoked' : 'active',
          })),
        ),
    // Same reasoning as listWebhooks — show "no keys" when the API is
    // unreachable rather than fake credentials the user can't manage.
    () => [],
  );

export const issueApiKey = ({ name, scope, rateLimit, expiresAt, tenantId = 'default' }) =>
  fetch('/v1/admin/api-keys', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      tenantId,
      name,
      scope,
      rateLimitPerMinute: rateLimit,
      expiresAt,
    }),
  }).then(unwrap);

export const revokeApiKey = (id, reason) =>
  fetch(`/v1/admin/api-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: adminHeaders(),
    body: JSON.stringify({ reason }),
  }).then(unwrap);

// ──────── Rules (admin) ────────
export const listRules = () =>
  safe(
    () => fetch('/v1/admin/rules', { headers: adminHeaders() }).then(unwrap),
    () => [],
  );

/**
 * Create or update a rule. The backend exposes
 *   POST /v1/admin/rules          → create
 *   PATCH /v1/admin/rules/:id     → partial update (`isActive`, name,
 *                                   expression, etc.)
 * The previous version of this helper used `PUT`, which the server
 * doesn't expose — every update silently 404'd and the rule editor's
 * `catch` block swallowed the error.
 *
 * A "new rule" is detected by the temporary `r_new_…` client id the
 * editor mints before the row exists server-side; we strip it so the
 * server picks a real UUID.
 */
export const saveRule = (rule) => {
  const isNew = !rule.id || String(rule.id).startsWith('r_new_');
  const url = isNew ? '/v1/admin/rules' : `/v1/admin/rules/${encodeURIComponent(rule.id)}`;
  const body = isNew ? { ...rule, id: undefined } : rule;
  return fetch(url, {
    method: isNew ? 'POST' : 'PATCH',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  }).then(unwrap);
};

/**
 * Toggle a rule's `isActive` flag. Same `PATCH /v1/admin/rules/:id`
 * route, just a one-field body — split out so the on/off switch in the
 * rules list reads as a single intent rather than a full save.
 */
export const setRuleActive = (id, isActive) =>
  fetch(`/v1/admin/rules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: JSON.stringify({ isActive }),
  }).then(unwrap);

export const deleteRule = (id) =>
  fetch(`/v1/admin/rules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

// ──────── Models (admin) ────────
// Flatten the API row into the shape the page consumes. The server
// stores metrics nested under `metrics` (f1_score / auc_roc etc.) so
// without this hoist the table renders blank "F1 / AUC" columns.
function normalizeModelRow(r) {
  const metrics = (r && r.metrics) || {};
  return {
    ...r,
    sha256: r.sha256 || '—',
    F1: metrics.f1_score ?? r.F1 ?? null,
    AUC: metrics.auc_roc ?? r.AUC ?? null,
    precision: metrics.precision ?? r.precision ?? null,
    recall: metrics.recall ?? r.recall ?? null,
    metrics,
    metadata: r.metadata || {},
    deployedAt: r.activatedAt
      ? new Date(r.activatedAt).toLocaleDateString()
      : r.deployedAt || '—',
    traffic:
      r.status === 'ACTIVE' ? '100%' : r.status === 'SHADOW' ? 'shadow' : '—',
  };
}

export const listModels = () =>
  safe(
    () =>
      fetch('/v1/admin/models', { headers: adminHeaders() })
        .then(unwrap)
        .then((rows) => (Array.isArray(rows) ? rows.map(normalizeModelRow) : [])),
    () => [],
  );

// Pull the running RDA feature catalogue. Returns
// `{ schemaVersion, baseVersion, inputDimension, adopterSha256, features }`.
// The Sentinel "Features" page renders this read-only — the catalogue is
// edited on disk (`models/feature-catalog.adopter.json`) and picked up on
// the next RDA restart.
export const getFeatureCatalog = () =>
  safe(
    () => fetch('/v1/admin/features/catalog', { headers: adminHeaders() }).then(unwrap),
    () => null,
  );

export const registerModel = (model) =>
  fetch('/v1/admin/models', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(model),
  }).then(unwrap);

// Status transition is a POST per the admin route definition
// (`models.route.ts`). Older revisions of this helper used PATCH which
// returned a silent 404 — operators saw the optimistic UI flip while
// the backend never moved.
export const setModelStatus = (version, status) =>
  fetch(`/v1/admin/models/${encodeURIComponent(version)}/status`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ status }),
  }).then(unwrap);

export const setSegmentThreshold = ({ segment, modelVersion, threshold }) =>
  fetch('/v1/admin/segment-thresholds', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ segment, modelVersion, threshold }),
  }).then(unwrap);

// Hard-delete a RETIRED model version. RDA refuses ACTIVE / SHADOW
// with 409 — callers should retire first via setModelStatus.
// Requires the `models:delete` permission on the caller's JWT.
export const deleteModel = (version) =>
  fetch(`/v1/admin/models/${encodeURIComponent(version)}`, {
    method: 'DELETE',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

// ──────── Webhooks (admin) ────────
// Mock fallback removed — adopters were confused by demo URLs they
// hadn't subscribed to. An empty list ("no subscriptions yet") is
// truthful when the API is unreachable or has no rows.
export const listWebhooks = () =>
  safe(
    () =>
      fetch('/v1/admin/webhooks', { headers: adminHeaders() }).then(unwrap),
    () => [],
  );

export const subscribeWebhook = (sub) =>
  fetch('/v1/admin/webhooks', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(sub),
  }).then(unwrap);

export const deleteWebhook = (id) =>
  fetch(`/v1/admin/webhooks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

// ──────── FIA (investigation reports) ────────
// Returns `{ reports, total, live }` so the UI can distinguish
// "FIA returned no reports" from "FIA is unreachable", and so the
// Investigations page can render real pagination. Server-side filters
// (`status`, `verdict`, `search`) are pushed all the way down to the
// SQL — see fia-service/src/persistence/report_writer.py.
export const listReports = async ({
  limit = 25,
  offset = 0,
  verdict,
  search,
  status,
} = {}) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));
  if (verdict) qs.set('verdict', verdict);
  if (search) qs.set('search', search);
  if (status) qs.set('status', status);
  try {
    const data = await fetch(`/fia/v1/reports?${qs.toString()}`, {
      headers: adminHeaders({ body: false }),
    }).then(unwrap);
    const reports = Array.isArray(data?.reports)
      ? data.reports
      : Array.isArray(data)
      ? data
      : [];
    const total = Number.isFinite(data?.total) ? data.total : reports.length;
    return { reports, total, live: true };
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[sentinel] FIA reports unreachable:', err.message);
    }
    return { reports: [], total: 0, live: false };
  }
};

export const requestReport = (transactionId) =>
  fetch('/fia/v1/reports', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ transactionId }),
  }).then(unwrap);

// FIA expects `{ content }` per docs/FIA-API.md. The frontend previously
// sent `{ body }`, which 400'd silently on every follow-up message and
// surfaced as "Follow-up failed" in the chat without an actionable error.
export const postReportMessage = (reportId, content) =>
  fetch(`/fia/v1/reports/${encodeURIComponent(reportId)}/messages`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ content }),
  }).then(unwrap);

// ──────── Audit log + transactions (admin, with filters) ────────
// Build the shared `?from&to&decision=…&search=…` query string used by
// both the audit log endpoint and the (functionally identical) transactions
// list endpoint. Empty / null values are dropped so the URL stays clean.
const buildAuditQuery = (filters = {}) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      qs.set(k, v.join(','));
    } else if (typeof v === 'boolean') {
      if (v) qs.set(k, '1');
    } else {
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
};

export const listAuditRows = (filters = {}) =>
  safe(
    () =>
      fetch(`/v1/admin/audit${buildAuditQuery(filters)}`, {
        headers: adminHeaders(),
      }).then(unwrap),
    () => ({ rows: [], total: 0, limit: filters.limit || 50, offset: filters.offset || 0 }),
  );

/**
 * Server-side count of pending review-queue items (unreviewed DECLINEs).
 * `/v1/review-queue` is capped at ~100 rows so its `length` is not a
 * reliable count; the audit endpoint with `pending=1&decision=DECLINE`
 * exposes the real total cheaply (`limit=1` keeps the payload small).
 * Returns `null` when the request fails so callers can fall back to
 * their local view rather than rendering "0".
 */
export const getReviewQueueCount = async () => {
  try {
    const url = `/v1/admin/audit${buildAuditQuery({ pending: true, decision: ['DECLINE'], limit: 1 })}`;
    const res = await fetch(url, { headers: adminHeaders() }).then(unwrap);
    return typeof res?.total === 'number' ? res.total : null;
  } catch {
    return null;
  }
};

export const listTransactions = (filters = {}) =>
  safe(
    () =>
      fetch(`/v1/transactions${buildAuditQuery(filters)}`, {
        headers: adminHeaders(),
      }).then(unwrap),
    () => ({ rows: [], total: 0, limit: filters.limit || 50, offset: filters.offset || 0 }),
  );

/**
 * Page through `/v1/transactions` with the supplied filters and return
 * every matching row up to `maxRows`. Used by the Transactions page's
 * Export CSV button. The cap exists so a poorly-scoped export doesn't
 * pull half a million rows into the browser; the UI surfaces a "first
 * N exported" message when we trip it. `onProgress(loaded, total)` is
 * called after every page so the button can show a counter.
 */
export const exportTransactions = async (filters = {}, { maxRows = 5000, pageSize = 500, onProgress } = {}) => {
  const collected = [];
  let total = 0;
  let offset = 0;
  while (collected.length < maxRows) {
    const limit = Math.min(pageSize, maxRows - collected.length);
    const res = await fetch(
      `/v1/transactions${buildAuditQuery({ ...filters, limit, offset })}`,
      { headers: adminHeaders() },
    ).then(unwrap);
    const rows = res?.rows || [];
    total = res?.total ?? total;
    if (rows.length === 0) break;
    collected.push(...rows);
    if (typeof onProgress === 'function') onProgress(collected.length, total);
    if (rows.length < limit) break; // last page
    offset += rows.length;
  }
  return { rows: collected, total, truncated: total > collected.length };
};

/**
 * Audit-log export. Same paging pattern as `exportTransactions` but
 * against `/v1/admin/audit`, which carries extra fields the transactions
 * endpoint doesn't (override metadata, model versions, rule context).
 * Caps and progress callback match the sibling function for consistency.
 */
export const exportAuditRows = async (filters = {}, { maxRows = 5000, pageSize = 500, onProgress } = {}) => {
  const collected = [];
  let total = 0;
  let offset = 0;
  while (collected.length < maxRows) {
    const limit = Math.min(pageSize, maxRows - collected.length);
    const res = await fetch(
      `/v1/admin/audit${buildAuditQuery({ ...filters, limit, offset })}`,
      { headers: adminHeaders() },
    ).then(unwrap);
    const rows = res?.rows || [];
    total = res?.total ?? total;
    if (rows.length === 0) break;
    collected.push(...rows);
    if (typeof onProgress === 'function') onProgress(collected.length, total);
    if (rows.length < limit) break;
    offset += rows.length;
  }
  return { rows: collected, total, truncated: total > collected.length };
};

// ──────── Saved reports (admin) ────────
// Operator-defined views over an existing data source (currently the
// decision audit log). The page persists `{ name, dataSource, filters,
// columns }` rows server-side and runs / exports them on demand.
export const listSavedReports = () =>
  safe(
    () => fetch('/v1/admin/saved-reports', { headers: adminHeaders() }).then(unwrap),
    () => [],
  );

export const savedReportsCatalogue = () =>
  safe(
    () =>
      fetch('/v1/admin/saved-reports/catalogue', { headers: adminHeaders() }).then(unwrap),
    () => ({ sources: [{ id: 'audit', columns: [] }] }),
  );

export const createSavedReport = (body) =>
  fetch('/v1/admin/saved-reports', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  }).then(unwrap);

export const updateSavedReport = (id, body) =>
  fetch(`/v1/admin/saved-reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  }).then(unwrap);

export const deleteSavedReport = (id) =>
  fetch(`/v1/admin/saved-reports/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

export const runSavedReport = (id, { limit = 100, offset = 0, override } = {}) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));
  return fetch(`/v1/admin/saved-reports/${encodeURIComponent(id)}/run?${qs.toString()}`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ override: override || {} }),
  }).then(unwrap);
};

/**
 * Trigger a CSV / JSON download. We don't go through unwrap() because
 * the response is a binary blob, not a `{ success, data }` envelope —
 * the browser does the actual save via an `<a download>` click.
 */
export const exportSavedReport = async (id, { format = 'csv', override } = {}) => {
  const qs = new URLSearchParams();
  qs.set('format', format);
  const res = await fetch(
    `/v1/admin/saved-reports/${encodeURIComponent(id)}/export?${qs.toString()}`,
    {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ override: override || {} }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `saved-report-${id}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// ──────── Segment thresholds (admin) ────────
export const listSegmentThresholds = () =>
  safe(
    () =>
      fetch('/v1/admin/segment-thresholds', { headers: adminHeaders() }).then(
        unwrap,
      ),
    () => [],
  );

// ──────── Webhook deliveries (admin) ────────
export const listWebhookDeliveries = ({ limit = 25, status } = {}) =>
  safe(
    () => {
      const qs = new URLSearchParams();
      qs.set('limit', String(limit));
      if (status) qs.set('status', status);
      return fetch(`/v1/admin/webhook-deliveries?${qs.toString()}`, {
        headers: adminHeaders(),
      }).then(unwrap);
    },
    () => [],
  );

// ──────── Recent decisions (live decisions polling + similar cases) ────────
export const listRecentDecisions = ({ since, limit = 50 } = {}) =>
  safe(
    () => {
      const qs = new URLSearchParams();
      if (since) qs.set('since', since);
      if (limit) qs.set('limit', String(limit));
      return fetch(`/v1/decisions/recent?${qs.toString()}`, {
        headers: adminHeaders(),
      }).then(unwrap);
    },
    () => [],
  );

export const listSimilarDecisions = (auditId, { limit = 5 } = {}) =>
  safe(
    () => {
      const qs = new URLSearchParams();
      if (limit) qs.set('limit', String(limit));
      return fetch(
        `/v1/decisions/${encodeURIComponent(auditId)}/similar?${qs.toString()}`,
        { headers: adminHeaders() },
      ).then(unwrap);
    },
    () => [],
  );

// ──────── Reason-code catalogue (audit log filters) ────────
export const listReasonCodes = () =>
  safe(
    () =>
      fetch('/v1/admin/audit/reason-codes', { headers: adminHeaders() }).then(
        unwrap,
      ),
    () => [],
  );

// ──────── Model comparison (registry page) ────────
export const getModelComparison = ({ championVersion, shadowVersion, from, to } = {}) =>
  safe(
    () => {
      const qs = new URLSearchParams();
      if (championVersion) qs.set('championVersion', championVersion);
      if (shadowVersion) qs.set('shadowVersion', shadowVersion);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const url = `/v1/admin/models/comparison${qs.toString() ? '?' + qs.toString() : ''}`;
      return fetch(url, { headers: adminHeaders() }).then(unwrap);
    },
    () => null,
  );

// ──────── Window + latency rollups (metrics + dashboard tile) ────────
export const getStatsWindow = ({ seconds = 86400, sparklineBuckets = 11 } = {}) =>
  safe(
    () => {
      const qs = new URLSearchParams();
      qs.set('seconds', String(seconds));
      qs.set('sparklineBuckets', String(sparklineBuckets));
      return fetch(`/v1/stats/window?${qs.toString()}`, {
        headers: adminHeaders(),
      }).then(unwrap);
    },
    () => null,
  );

export const getLatencyTimeseries = ({ from, to, bucketMinutes = 60 } = {}) =>
  safe(
    () => {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      qs.set('bucketMinutes', String(bucketMinutes));
      return fetch(`/v1/stats/latency?${qs.toString()}`, {
        headers: adminHeaders(),
      }).then(unwrap);
    },
    () => ({ buckets: [] }),
  );

// ──────── Health (services + infra) ────────
export const getServiceHealth = () =>
  safe(
    () => fetch('/v1/health/services', { headers: adminHeaders() }).then(unwrap),
    () => [],
  );

export const getInfraHealth = () =>
  safe(
    () => fetch('/v1/health/infra', { headers: adminHeaders() }).then(unwrap),
    () => [],
  );

// ──────── Today's stats (dashboard + metrics) ────────
// Fallback is an *empty* shape so the UI renders "—" on a fresh DB —
// the old fallback shipped seeded numbers that were indistinguishable
// from real data.
export const getStatsToday = ({ since } = {}) =>
  safe(
    () => {
      const qs = new URLSearchParams();
      if (since) qs.set('since', since);
      return fetch(`/v1/stats/today${qs.toString() ? '?' + qs.toString() : ''}`, {
        headers: adminHeaders(),
      }).then(unwrap);
    },
    () => ({
      since: null,
      total: 0,
      counts: { ACCEPT: 0, DECLINE: 0, REVIEW: 0 },
      rates: { decline: 0, review: 0 },
      topReasonCodes: [],
    }),
  );

// ──────── Review queue + decisions (admin) ────────
// Always paginated: returns `{ rows, total, limit, offset }`. The
// backing table can run into the thousands so unpaginated reads are
// not supported. Callers must request a page slice.
export const listReviewQueue = ({ limit = 25, offset = 0, order = 'newest', search = '' } = {}) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));
  if (order) qs.set('order', order);
  if (search) qs.set('search', search);
  return safe(
    () => fetch(`/v1/review-queue?${qs.toString()}`, { headers: adminHeaders() }).then(unwrap),
    () => ({ rows: [], total: 0, limit, offset }),
  );
};

export const getDecision = (transactionId) =>
  fetch(`/v1/decisions/${encodeURIComponent(transactionId)}`, {
    headers: adminHeaders(),
  }).then(unwrap);

export const overrideDecision = (auditId, body) =>
  fetch(`/v1/decisions/${encodeURIComponent(auditId)}/override`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(body),
  }).then(unwrap);

// ──────── Aggregates for the dashboard landing page ────────
export const loadDashboardBundle = async () => {
  const [models, webhooks, reportsRes] = await Promise.all([
    listModels(),
    listWebhooks(),
    listReports(),
  ]);
  return {
    // Every list starts empty when the API is unreachable. The
    // per-page empty-state copy tells the operator what to do next
    // (start RDA, run a migration, etc.) instead of populating fake
    // rows the operator can't actually action.
    queue: [],
    rules: [],
    models,
    segmentThresholds: [],
    reports: reportsRes.reports,
    apiKeys: [],
    webhooks,
    deliveries: [],
    champBuckets: new Array(20).fill(0),
    shadowBuckets: new Array(20).fill(0),
  };
};

// ──────── Settings (admin) ────────
//
// Runtime settings live in two places:
//   • RDA  /v1/admin/settings/runtime/* — the global fraud threshold
//     used as fallback when neither per-segment nor per-model
//     defaultThreshold is set.
//   • MLA  /mla/v1/admin/drift-config — drift detection knobs that
//     decide when MLA retrains.
//
// The Settings page reads both. Writes are role-gated server-side
// (settings:write for fraud threshold, mla:configure for drift / retrain),
// so a FRAUD_ANALYST with settings:read can view but not edit.

export const listRuntimeSettings = () =>
  safe(
    () => fetch('/v1/admin/settings/runtime', { headers: adminHeaders() }).then(unwrap),
    () => [],
  );

export const updateRuntimeSetting = (key, value) =>
  fetch(`/v1/admin/settings/runtime/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({ value }),
  }).then(unwrap);

export const getDriftConfig = () =>
  safe(
    () => fetch('/mla/v1/admin/drift-config', { headers: adminHeaders() }).then(unwrap),
    () => null,
  );

export const updateDriftConfig = ({ driftF1Threshold, driftPsiThreshold, driftWindowSize, autoRetrainEnabled }) =>
  fetch('/mla/v1/admin/drift-config', {
    method: 'PUT',
    headers: adminHeaders(),
    body: JSON.stringify({ driftF1Threshold, driftPsiThreshold, driftWindowSize, autoRetrainEnabled }),
  }).then(unwrap);

export const triggerManualRetrain = () =>
  fetch('/mla/v1/admin/retrain', {
    method: 'POST',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

export const listRetrainRuns = () =>
  safe(
    () => fetch('/mla/v1/admin/retrain-runs', { headers: adminHeaders() }).then(unwrap),
    () => [],
  );

// ──────── Adopter training-data import ────────
export const listTrainingImports = ({ limit = 25, offset = 0 } = {}) => {
  const qs = new URLSearchParams();
  qs.set('limit', String(limit));
  qs.set('offset', String(offset));
  return safe(
    () => fetch(`/v1/admin/training/imports?${qs.toString()}`, { headers: adminHeaders() }).then(unwrap),
    () => ({ rows: [], total: 0, limit, offset }),
  );
};

export const createTrainingImport = (source) =>
  fetch('/v1/admin/training/import', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ source }),
  }).then(unwrap);

export const getTrainingImport = (jobId) =>
  safe(
    () =>
      fetch(`/v1/admin/training/import/${encodeURIComponent(jobId)}`, {
        headers: adminHeaders(),
      }).then(unwrap),
    () => null,
  );

export const initTrainingUpload = ({ filename, expectedBytes, expectedSha256 }) =>
  fetch('/v1/admin/training/upload/init', {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ filename, expectedBytes, expectedSha256 }),
  }).then(unwrap);

export const putTrainingUploadChunk = ({ uploadId, offset, bytes }) =>
  fetch(
    `/v1/admin/training/upload/${encodeURIComponent(uploadId)}/chunk?offset=${encodeURIComponent(offset)}`,
    {
      method: 'PUT',
      headers: { ...adminHeaders({ body: false }), 'Content-Type': 'application/octet-stream' },
      body: bytes,
    },
  ).then(unwrap);

export const completeTrainingUpload = (uploadId, transformSpec) =>
  fetch(`/v1/admin/training/upload/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ transformSpec: transformSpec ?? null }),
  }).then(unwrap);

export const abandonTrainingUpload = (uploadId) =>
  fetch(`/v1/admin/training/upload/${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);

export const promoteTrainingImport = (jobId) =>
  fetch(`/v1/admin/training/import/${encodeURIComponent(jobId)}/promote`, {
    method: 'POST',
    headers: adminHeaders({ body: false }),
  }).then(unwrap);
