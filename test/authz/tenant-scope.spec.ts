import { resolveTenantScope } from "../../src/shared/authz/tenant-scope";
import type { AuthSubject } from "../../src/shared/authz/auth.service";

const subject = (overrides: Partial<AuthSubject> = {}): AuthSubject => ({
  userId: "u1",
  tenantId: "acme",
  username: "alice",
  permissions: [],
  ...overrides,
});

describe("resolveTenantScope", () => {
  it("falls back to the caller's tenant when the request omits one", () => {
    expect(resolveTenantScope(subject(), undefined)).toBe("acme");
    expect(resolveTenantScope(subject(), null)).toBe("acme");
    expect(resolveTenantScope(subject(), "")).toBe("acme");
  });

  it("falls back to 'default' when there is no authenticated subject", () => {
    expect(resolveTenantScope(undefined, undefined)).toBe("default");
    expect(resolveTenantScope(undefined, "globex")).toBe("default");
  });

  it("allows the caller to specify their own tenant explicitly", () => {
    expect(resolveTenantScope(subject(), "acme")).toBe("acme");
  });

  it("silently narrows cross-tenant requests when the caller lacks tenants:admin_any", () => {
    // The audit found that admin controllers took tenantId from the
    // body and never compared it to the caller's. The fix narrows
    // rather than 403s so a copy-pasted request can't escalate.
    expect(resolveTenantScope(subject(), "globex")).toBe("acme");
  });

  it("honors a cross-tenant request when the caller holds tenants:admin_any", () => {
    expect(
      resolveTenantScope(subject({ permissions: ["tenants:admin_any"] }), "globex")
    ).toBe("globex");
  });

  it("treats SUPER_ADMIN ('*') as holding every permission, including tenants:admin_any", () => {
    expect(resolveTenantScope(subject({ permissions: ["*"] }), "globex")).toBe("globex");
  });
});
