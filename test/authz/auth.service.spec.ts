import "reflect-metadata";
import bcrypt from "bcrypt";
import AuthService, { InvalidCredentialsError, AuthConfigError } from "../../src/shared/authz/auth.service";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.AUTH_JWT_SECRET = "test-secret-test-secret-test-secret-test"; // 40 chars
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("AuthService.login", () => {
  it("rejects unknown users", async () => {
    const users = {
      async findByUsername() {
        return undefined;
      },
      async findByIdWithRoles() {
        return null;
      },
      async touchLastLogin() {
        /* noop */
      },
    };
    const svc = new AuthService(users as never);
    await expect(svc.login({ username: "ghost", password: "x" })).rejects.toThrow(
      InvalidCredentialsError
    );
  });

  it("rejects inactive users even with correct password", async () => {
    const passwordHash = await bcrypt.hash("correct", 4);
    const users = {
      async findByUsername() {
        return { id: "u1", username: "u", passwordHash, isActive: false };
      },
      async findByIdWithRoles() {
        return null;
      },
      async touchLastLogin() {
        /* noop */
      },
    };
    const svc = new AuthService(users as never);
    await expect(svc.login({ username: "u", password: "correct" })).rejects.toThrow(
      InvalidCredentialsError
    );
  });

  it("rejects wrong password", async () => {
    const passwordHash = await bcrypt.hash("correct", 4);
    const users = {
      async findByUsername() {
        return { id: "u1", username: "u", passwordHash, isActive: true };
      },
      async findByIdWithRoles() {
        return null;
      },
      async touchLastLogin() {
        /* noop */
      },
    };
    const svc = new AuthService(users as never);
    await expect(svc.login({ username: "u", password: "wrong" })).rejects.toThrow(
      InvalidCredentialsError
    );
  });

  it("issues a JWT and merges role permissions on success", async () => {
    const passwordHash = await bcrypt.hash("correct", 4);
    const users = {
      async findByUsername() {
        return { id: "u1", username: "u", passwordHash, isActive: true };
      },
      async findByIdWithRoles() {
        return {
          id: "u1",
          username: "u",
          fullName: null,
          email: null,
          tenantId: "default",
          isActive: true,
          lastLoginAt: null,
          createdAt: new Date(),
          roles: [
            { id: "r1", name: "FRAUD_ANALYST", permissions: ["rules:read", "metrics:read"] },
            { id: "r2", name: "OPERATIONS", permissions: ["rules:read", "rules:create"] },
          ],
        };
      },
      async touchLastLogin() {
        /* noop */
      },
    };
    const svc = new AuthService(users as never);
    const result = await svc.login({ username: "u", password: "correct" });
    expect(result.token).toMatch(/^eyJ/); // any well-formed JWT
    expect(result.user.permissions.sort()).toEqual(
      ["rules:read", "metrics:read", "rules:create"].sort()
    );

    // The token must round-trip through verifyToken. Compare sorted —
    // Set merge order isn't guaranteed across roles, only de-duplication is.
    const subject = svc.verifyToken(result.token);
    expect(subject?.username).toBe("u");
    expect([...(subject?.permissions ?? [])].sort()).toEqual(
      [...result.user.permissions].sort()
    );
  });

  it("fails with AuthConfigError when AUTH_JWT_SECRET is too short", async () => {
    process.env.AUTH_JWT_SECRET = "short";
    const passwordHash = await bcrypt.hash("correct", 4);
    const users = {
      async findByUsername() {
        return { id: "u1", username: "u", passwordHash, isActive: true };
      },
      async findByIdWithRoles() {
        return {
          id: "u1",
          username: "u",
          fullName: null,
          email: null,
          tenantId: "default",
          isActive: true,
          lastLoginAt: null,
          createdAt: new Date(),
          roles: [{ id: "r1", name: "X", permissions: ["rules:read"] }],
        };
      },
      async touchLastLogin() {
        /* noop */
      },
    };
    const svc = new AuthService(users as never);
    await expect(svc.login({ username: "u", password: "correct" })).rejects.toThrow(
      AuthConfigError
    );
  });
});

describe("AuthService.hasPermission", () => {
  it("the wildcard satisfies any required permission", () => {
    const subject = {
      userId: "u",
      username: "u",
      tenantId: "default",
      permissions: ["*"],
    };
    expect(AuthService.hasPermission(subject, ["rules:delete", "users:delete"])).toBe(true);
  });

  it("returns true when at least one required code is held", () => {
    const subject = {
      userId: "u",
      username: "u",
      tenantId: "default",
      permissions: ["rules:read"],
    };
    expect(AuthService.hasPermission(subject, ["rules:read", "rules:update"])).toBe(true);
  });

  it("returns false when no required code is held", () => {
    const subject = {
      userId: "u",
      username: "u",
      tenantId: "default",
      permissions: ["metrics:read"],
    };
    expect(AuthService.hasPermission(subject, ["rules:update"])).toBe(false);
  });

  it("an empty requirement list passes any subject (logged-in only)", () => {
    const subject = {
      userId: "u",
      username: "u",
      tenantId: "default",
      permissions: [],
    };
    expect(AuthService.hasPermission(subject, [])).toBe(true);
  });
});

describe("AuthService.verifyToken", () => {
  it("rejects garbage tokens", () => {
    const svc = new AuthService({} as never);
    expect(svc.verifyToken("not-a-jwt")).toBeNull();
  });
});

describe("AuthService — mustChangePassword JWT claim", () => {
  const userRow = {
    id: "u-1",
    username: "alice",
    tenantId: "default",
    isActive: true,
    mustChangePassword: true,
  };
  const detail = {
    id: "u-1",
    username: "alice",
    fullName: "Alice A",
    tenantId: "default",
    roles: [{ id: "r-1", name: "OPERATIONS", permissions: ["rules:read"] }],
  };

  async function buildUsersMock(pwHash: string) {
    return {
      async findByUsername() {
        return { ...userRow, passwordHash: pwHash };
      },
      async findById() {
        return { ...userRow, passwordHash: pwHash };
      },
      async findByIdWithRoles() {
        return detail;
      },
      async updateById() {
        userRow.mustChangePassword = false;
      },
      async touchLastLogin() {
        /* noop */
      },
    };
  }

  it("login mints a JWT whose mustChangePassword matches the user row", async () => {
    const pwHash = await bcrypt.hash("CorrectHorseBatteryStaple1!", 4);
    const users = await buildUsersMock(pwHash);
    const svc = new AuthService(users as never);

    const result = await svc.login({ username: "alice", password: "CorrectHorseBatteryStaple1!" });

    // Response surface still carries the flag for the frontend.
    expect(result.user.mustChangePassword).toBe(true);

    // verifyToken on the same token exposes it on the AuthSubject.
    const subject = svc.verifyToken(result.token);
    expect(subject).not.toBeNull();
    expect(subject!.mustChangePassword).toBe(true);
  });

  it("verifyToken defaults mustChangePassword to false for tokens minted without the claim", () => {
    // Simulate a pre-existing token that pre-dates the claim by signing one
    // without including `mustChangePassword` in the payload.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jwt = require("jsonwebtoken");
    const legacyToken = jwt.sign(
      { userId: "u-1", tenantId: "default", username: "legacy", permissions: ["audit:read"] },
      process.env.AUTH_JWT_SECRET,
      { algorithm: "HS256", expiresIn: 60 }
    );

    const svc = new AuthService({} as never);
    const subject = svc.verifyToken(legacyToken);
    expect(subject).not.toBeNull();
    expect(subject!.mustChangePassword).toBe(false);
  });

  it("changePassword returns a fresh token with mustChangePassword=false", async () => {
    const pwHash = await bcrypt.hash("OldPassword1!", 4);
    userRow.mustChangePassword = true;
    const users = await buildUsersMock(pwHash);
    const svc = new AuthService(users as never);

    const result = await svc.changePassword({
      userId: "u-1",
      currentPassword: "OldPassword1!",
      newPassword: "Xq7%vB#m9KrL2NpQ$wZ4!",
    });

    expect(typeof result.token).toBe("string");
    expect(typeof result.expiresAt).toBe("string");

    const subject = svc.verifyToken(result.token);
    expect(subject).not.toBeNull();
    expect(subject!.mustChangePassword).toBe(false);
  });
});
