import { AuthSubject } from "./auth.service";

/**
 * Resolve which tenantId an admin write should target.
 *
 * - If the caller did not pass a tenantId, use their own (or "default").
 * - If they passed one that matches their own, allow it.
 * - If they passed a different one, require `tenants:admin_any`. Without
 *   that permission, the request is silently scoped to the caller's own
 *   tenantId — we choose narrowing-by-default over a 403 so a copy-pasted
 *   request can't escalate.
 *
 * The wildcard `*` permission (SUPER_ADMIN) grants `tenants:admin_any`
 * implicitly via `AuthService.hasPermission`.
 */
export function resolveTenantScope(
  auth: AuthSubject | undefined,
  requestedTenantId: string | undefined | null
): string {
  const own = auth?.tenantId ?? "default";
  if (!requestedTenantId || requestedTenantId === own) return own;

  const perms = auth?.permissions ?? [];
  if (perms.includes("*") || perms.includes("tenants:admin_any")) {
    return requestedTenantId;
  }
  return own;
}
