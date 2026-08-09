import "reflect-metadata";
import { container } from "tsyringe";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import AuthService from "../../src/shared/authz/auth.service";
import { requireAuth } from "../../src/shared/middlewares/require-auth.middleware";

const SECRET = "test-secret-test-secret-test-secret-test";

// Grants are resolved live from the user row, not from the token's
// permission claim — these drive what the stubbed repo returns.
let dbPermissions: string[];
let dbIsActive: boolean;

function fakeUserRepo() {
  return {
    findByIdWithRoles: async (id: string) => ({
      id,
      username: "alice",
      fullName: null,
      email: null,
      tenantId: "default",
      isActive: dbIsActive,
      mustChangePassword: false,
      lastLoginAt: null,
      createdAt: new Date(),
      roles: [{ id: "r1", name: "TEST_ROLE", permissions: dbPermissions }],
    }),
  };
}

function sign(subject: { userId: string; tenantId: string; username: string; permissions: string[] }) {
  return jwt.sign(subject, SECRET, { expiresIn: 300 });
}

function buildApp() {
  const app = Fastify();
  app.get("/open", { preHandler: requireAuth() }, async () => ({ ok: true }));
  app.get(
    "/rules",
    { preHandler: requireAuth("rules:read", "rules:update") },
    async (req) => ({ ok: true, who: req.auth?.username })
  );
  return app;
}

beforeEach(() => {
  process.env.AUTH_JWT_SECRET = SECRET;
  dbPermissions = [];
  dbIsActive = true;
  container.register(AuthService, { useValue: new AuthService(fakeUserRepo() as never) });
});

describe("requireAuth()", () => {
  it("rejects missing Authorization header with 401", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/open" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects malformed bearer with 401", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/open",
      headers: { authorization: "Token abc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid token with 401", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/open",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("passes when any required permission is held", async () => {
    const app = buildApp();
    dbPermissions = ["rules:read"];
    const token = sign({
      userId: "u1",
      tenantId: "default",
      username: "alice",
      permissions: [],
    });
    const res = await app.inject({
      method: "GET",
      url: "/rules",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, who: "alice" });
  });

  it("returns 403 when none of the required permissions are held", async () => {
    const app = buildApp();
    dbPermissions = ["metrics:read"];
    const token = sign({
      userId: "u1",
      tenantId: "default",
      username: "alice",
      permissions: ["rules:read"],
    });
    const res = await app.inject({
      method: "GET",
      url: "/rules",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("wildcard permission satisfies any required code", async () => {
    const app = buildApp();
    dbPermissions = ["*"];
    const token = sign({
      userId: "u1",
      tenantId: "default",
      username: "root",
      permissions: [],
    });
    const res = await app.inject({
      method: "GET",
      url: "/rules",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a deactivated user's still-valid token with 401", async () => {
    const app = buildApp();
    dbPermissions = ["rules:read"];
    dbIsActive = false;
    const token = sign({
      userId: "u1",
      tenantId: "default",
      username: "alice",
      permissions: ["rules:read"],
    });
    const res = await app.inject({
      method: "GET",
      url: "/rules",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
