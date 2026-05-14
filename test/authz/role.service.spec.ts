import "reflect-metadata";
import RoleService, { validatePermissions } from "../../src/shared/authz/role.service";
import { ConflictError } from "../../src/shared/authz/user.service";

describe("validatePermissions()", () => {
  it("accepts a known catalogue code", () => {
    expect(validatePermissions(["rules:read"], { allowWildcard: false })).toEqual(["rules:read"]);
  });

  it("dedupes repeats", () => {
    expect(validatePermissions(["rules:read", "rules:read"], { allowWildcard: false })).toEqual([
      "rules:read",
    ]);
  });

  it("rejects unknown codes", () => {
    expect(() => validatePermissions(["bogus:perm"], { allowWildcard: false })).toThrow(
      ConflictError
    );
  });

  it("rejects the wildcard when not explicitly allowed", () => {
    expect(() => validatePermissions(["*"], { allowWildcard: false })).toThrow(ConflictError);
  });

  it("accepts the wildcard when explicitly allowed", () => {
    expect(validatePermissions(["*"], { allowWildcard: true })).toEqual(["*"]);
  });

  it("rejects empty strings and non-strings", () => {
    expect(() => validatePermissions([""], { allowWildcard: false })).toThrow(ConflictError);
    expect(() =>
      validatePermissions([null as unknown as string], { allowWildcard: false })
    ).toThrow(ConflictError);
  });
});

describe("RoleService.create() / update() guards", () => {
  // Build a tiny in-memory repo so we can drive the service without a DB.
  const buildRepo = () => {
    const store = new Map<string, Record<string, unknown>>();
    return {
      store,
      async findById(id: string) {
        return store.get(id);
      },
      async findByName(tenantId: string, name: string) {
        for (const r of store.values()) {
          if (r.tenantId === tenantId && r.name === name) return r;
        }
        return undefined;
      },
      async list() {
        return Array.from(store.values());
      },
      async create(input: Record<string, unknown>) {
        const row = { id: `r_${store.size + 1}`, ...input };
        store.set(row.id, row);
        return row;
      },
      async updateById(id: string, patch: Record<string, unknown>) {
        const cur = store.get(id);
        if (!cur) return undefined;
        const next = { ...cur, ...patch };
        store.set(id, next);
        return next;
      },
      async deleteById(id: string) {
        return store.delete(id) ? 1 : 0;
      },
    };
  };

  it("create requires at least one permission", async () => {
    const repo = buildRepo();
    const svc = new RoleService(repo as never);
    await expect(svc.create({ name: "x", permissions: [] })).rejects.toThrow(ConflictError);
  });

  it("create rejects duplicate name in the same tenant", async () => {
    const repo = buildRepo();
    const svc = new RoleService(repo as never);
    await svc.create({ name: "ops", permissions: ["rules:read"] });
    await expect(svc.create({ name: "ops", permissions: ["rules:read"] })).rejects.toThrow(
      ConflictError
    );
  });

  it("system roles cannot be deleted", async () => {
    const repo = buildRepo();
    repo.store.set("sys", {
      id: "sys",
      name: "SUPER_ADMIN",
      tenantId: "default",
      permissions: ["*"],
      isSystem: true,
    });
    const svc = new RoleService(repo as never);
    await expect(svc.delete("sys")).rejects.toThrow(ConflictError);
  });

  it("system roles cannot be renamed", async () => {
    const repo = buildRepo();
    repo.store.set("sys", {
      id: "sys",
      name: "FRAUD_ANALYST",
      tenantId: "default",
      permissions: ["rules:read"],
      isSystem: true,
    });
    const svc = new RoleService(repo as never);
    await expect(svc.update("sys", { name: "new-name" })).rejects.toThrow(ConflictError);
  });

  it("SUPER_ADMIN permissions cannot be edited", async () => {
    const repo = buildRepo();
    repo.store.set("sa", {
      id: "sa",
      name: "SUPER_ADMIN",
      tenantId: "default",
      permissions: ["*"],
      isSystem: true,
    });
    const svc = new RoleService(repo as never);
    await expect(svc.update("sa", { permissions: ["rules:read"] })).rejects.toThrow(ConflictError);
  });
});
