/**
 * Permission catalogue.
 *
 * Permissions are **code-defined** (not stored in their own table) so the
 * source of truth lives next to the routes they protect. The role table
 * stores an array of these codes; the runtime checks string membership.
 *
 * Pattern: `<resource>:<action>`. Keep it flat — no wildcards in the
 * catalogue; the `*` wildcard is only used by the `SUPER_ADMIN` role.
 *
 * When you add a new feature with admin endpoints, add the permission
 * codes here, reference them in the route's `requireAuth(...)` call,
 * and include them in any system role that should grant them. The
 * `GET /v1/admin/permissions` endpoint reads from `PERMISSIONS` so the
 * UI role editor picks new codes up automatically.
 */
export const PERMISSIONS = [
  // Users
  { code: "users:read", description: "View users and their roles" },
  { code: "users:create", description: "Create new users" },
  { code: "users:update", description: "Edit user details / change password / disable" },
  { code: "users:delete", description: "Delete users" },

  // Roles
  { code: "roles:read", description: "View roles and their permissions" },
  { code: "roles:create", description: "Create custom roles" },
  { code: "roles:update", description: "Edit role name / permissions" },
  { code: "roles:delete", description: "Delete custom roles" },

  // API keys
  { code: "api_keys:read", description: "List API keys" },
  { code: "api_keys:issue", description: "Issue a new API key" },
  { code: "api_keys:revoke", description: "Revoke an API key" },

  // Webhooks
  { code: "webhooks:read", description: "List webhook subscriptions and deliveries" },
  { code: "webhooks:create", description: "Subscribe a new webhook" },
  { code: "webhooks:delete", description: "Remove a webhook subscription" },

  // Rules
  { code: "rules:read", description: "List rules" },
  { code: "rules:create", description: "Create a new rule" },
  { code: "rules:update", description: "Edit / activate / deactivate a rule" },
  { code: "rules:delete", description: "Delete a rule" },

  // Models
  { code: "models:read", description: "List registered model versions" },
  { code: "models:register", description: "Register a candidate model" },
  { code: "models:set_status", description: "Activate / shadow / retire a model" },
  { code: "models:set_threshold", description: "Set per-segment thresholds" },
  { code: "models:delete", description: "Permanently delete a retired model version (row + on-disk artefacts)" },

  // Audit log
  { code: "audit:read", description: "Read the decision audit log" },

  // Review queue
  { code: "review_queue:read", description: "Read the analyst review queue" },
  { code: "review_queue:override", description: "Override a decision (confirm / release)" },

  // FIA reports
  { code: "reports:read", description: "List and read investigation reports" },
  { code: "reports:request", description: "Request an on-demand investigation report" },
  { code: "reports:message", description: "Send follow-up messages on a report" },

  // Metrics
  { code: "metrics:read", description: "Read Prometheus / dashboard metrics" },

  // Saved reports — analyst-defined views over an existing data source
  // (audit log etc.) that can be re-run and exported on demand.
  { code: "saved_reports:read", description: "List and run saved reports" },
  { code: "saved_reports:write", description: "Create, update, or delete saved reports" },
  { code: "saved_reports:export", description: "Export saved-report results as CSV / JSON" },

  // Runtime settings (Settings page)
  { code: "settings:read", description: "Read runtime settings (fraud threshold, drift thresholds, retrain history)" },
  { code: "settings:write", description: "Update runtime settings (fraud threshold)" },
  { code: "mla:configure", description: "Update MLA drift config and trigger manual retrains" },

  // Training data ingest
  { code: "training:read", description: "View training-data import jobs and their status" },
  { code: "training:write", description: "Submit and manage training-data import jobs" },

  // Ground-truth label ingest (chargebacks, disputes, customer reports)
  { code: "labels:write", description: "Push verified fraud outcomes onto transactions for model training" },

  // Cross-tenant scoping — required to issue API keys, register webhooks,
  // or create users for a tenant other than the caller's own. Without
  // this permission, the tenantId in the request body is ignored and the
  // caller's own tenantId from their JWT is used.
  { code: "tenants:admin_any", description: "Operate on any tenant's scope (issue keys, register webhooks, manage users across tenants)" },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]["code"];

/** Set of all valid permission codes — used to validate role updates. */
export const PERMISSION_CODES: Set<string> = new Set(PERMISSIONS.map((p) => p.code));

/** Wildcard granted only to the seeded SUPER_ADMIN role. */
export const ALL_PERMISSIONS = "*" as const;

/**
 * System roles seeded by the initial migration. `isSystem` rows cannot
 * be deleted (the route returns 409); they can be edited only by
 * `roles:update`, and `SUPER_ADMIN` is hard-pinned to `["*"]` so a
 * misclick doesn't lock everyone out.
 */
export const SYSTEM_ROLES = [
  {
    name: "SUPER_ADMIN",
    description: "Full access to every admin feature. Cannot be deleted; permissions are fixed at [\"*\"].",
    permissions: [ALL_PERMISSIONS],
  },
  {
    name: "FRAUD_ANALYST",
    description: "Read-only across detection + audit, can override decisions and ask FIA follow-ups.",
    permissions: [
      "review_queue:read",
      "review_queue:override",
      "audit:read",
      "reports:read",
      "reports:request",
      "reports:message",
      "rules:read",
      "models:read",
      "metrics:read",
      "saved_reports:read",
      "saved_reports:write",
      "saved_reports:export",
      "settings:read",
    ],
  },
  {
    name: "OPERATIONS",
    description: "Manage rules, models, API keys, webhooks. Cannot manage users.",
    permissions: [
      "rules:read",
      "rules:create",
      "rules:update",
      "rules:delete",
      "models:read",
      "models:register",
      "models:set_status",
      "models:set_threshold",
      "models:delete",
      "api_keys:read",
      "api_keys:issue",
      "api_keys:revoke",
      "webhooks:read",
      "webhooks:create",
      "webhooks:delete",
      "audit:read",
      "metrics:read",
      "reports:read",
      "saved_reports:read",
      "saved_reports:write",
      "saved_reports:export",
      "settings:read",
      "settings:write",
      "mla:configure",
    ],
  },
] as const;
