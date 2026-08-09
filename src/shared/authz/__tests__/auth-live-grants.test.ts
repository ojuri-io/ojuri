import "reflect-metadata";
import jwt from "jsonwebtoken";
import AuthService from "../auth.service";
import UserRepo, { UserWithRoles } from "../repositories/user.repo";

const SECRET = process.env.AUTH_JWT_SECRET as string;

function mintToken(overrides: Partial<Record<string, unknown>> = {}): string {
  return jwt.sign(
    {
      userId: "u1",
      tenantId: "default",
      username: "analyst",
      permissions: ["rules:read"],
      mustChangePassword: false,
      ...overrides,
    },
    SECRET,
    { algorithm: "HS256", expiresIn: 3600 }
  );
}

function userRow(overrides: Partial<UserWithRoles> = {}): UserWithRoles {
  return {
    id: "u1",
    username: "analyst",
    fullName: null,
    email: null,
    tenantId: "default",
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: new Date(),
    roles: [{ id: "r1", name: "FRAUD_ANALYST", permissions: ["rules:read"] }],
    ...overrides,
  };
}

function makeService(findByIdWithRoles: jest.Mock): { service: AuthService; repo: jest.Mock } {
  const repo = { findByIdWithRoles } as unknown as UserRepo;
  return { service: new AuthService(repo), repo: findByIdWithRoles };
}

describe("AuthService.verifyTokenLive", () => {
  it("overlays permissions from the database, not the token snapshot", async () => {
    const { service } = makeService(
      jest.fn().mockResolvedValue(
        userRow({
          roles: [{ id: "r2", name: "OPERATIONS", permissions: ["models:read", "metrics:read"] }],
        })
      )
    );

    const subject = await service.verifyTokenLive(mintToken({ permissions: ["rules:read"] }));

    expect(subject).not.toBeNull();
    expect(subject!.permissions.sort()).toEqual(["metrics:read", "models:read"]);
  });

  it("rejects a token whose user has been deactivated", async () => {
    const { service } = makeService(jest.fn().mockResolvedValue(userRow({ isActive: false })));

    expect(await service.verifyTokenLive(mintToken())).toBeNull();
  });

  it("rejects a token whose user has been deleted", async () => {
    const { service } = makeService(jest.fn().mockResolvedValue(null));

    expect(await service.verifyTokenLive(mintToken())).toBeNull();
  });

  it("reads mustChangePassword from the database, not the token", async () => {
    const { service } = makeService(
      jest.fn().mockResolvedValue(userRow({ mustChangePassword: true }))
    );

    const subject = await service.verifyTokenLive(mintToken({ mustChangePassword: false }));

    expect(subject!.mustChangePassword).toBe(true);
  });

  it("caches grants so repeated requests hit the database once", async () => {
    const { service, repo } = makeService(jest.fn().mockResolvedValue(userRow()));

    await service.verifyTokenLive(mintToken());
    await service.verifyTokenLive(mintToken());

    expect(repo).toHaveBeenCalledTimes(1);
  });

  it("re-reads after invalidateGrants for that user", async () => {
    const { service, repo } = makeService(jest.fn().mockResolvedValue(userRow()));

    await service.verifyTokenLive(mintToken());
    service.invalidateGrants("u1");
    await service.verifyTokenLive(mintToken());

    expect(repo).toHaveBeenCalledTimes(2);
  });

  it("re-reads everyone after a full invalidateGrants", async () => {
    const { service, repo } = makeService(jest.fn().mockResolvedValue(userRow()));

    await service.verifyTokenLive(mintToken());
    service.invalidateGrants();
    await service.verifyTokenLive(mintToken());

    expect(repo).toHaveBeenCalledTimes(2);
  });

  it("still rejects an invalid signature without touching the database", async () => {
    const { service, repo } = makeService(jest.fn().mockResolvedValue(userRow()));
    const forged = jwt.sign({ userId: "u1" }, "wrong-secret-wrong-secret-wrong", {
      algorithm: "HS256",
    });

    expect(await service.verifyTokenLive(forged)).toBeNull();
    expect(repo).not.toHaveBeenCalled();
  });
});
