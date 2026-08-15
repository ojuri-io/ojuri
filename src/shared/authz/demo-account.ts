/**
 * Shape of the optional public-demo identity, shared by the seed that creates
 * it and the sign-in route that reports whether it exists. Keeping both sides
 * on one constant is what makes the login page's claim ("sign in as demo")
 * provably match the account the seed actually wrote.
 */

export const DEMO_USERNAME = "demo";
export const DEMO_ROLE_NAME = "DEMO";

/**
 * Read-mostly by construction: everything that changes how decisions are made
 * (rules:update, models:set_status, models:set_threshold, settings:write,
 * review_queue:override) and everything touching identity (users:*, roles:*)
 * is deliberately absent. A visitor can observe the system and call the API.
 * They cannot alter what the next visitor sees.
 */
export const DEMO_PERMISSIONS = [
  "audit:read",
  "metrics:read",
  "review_queue:read",
  "reports:read",
  "reports:request",
  "reports:message",
  "rules:read",
  "models:read",
  "training:read",
  "saved_reports:read",
  "settings:read",
  "api_keys:read",
  "api_keys:issue",
  "api_keys:revoke",
];
