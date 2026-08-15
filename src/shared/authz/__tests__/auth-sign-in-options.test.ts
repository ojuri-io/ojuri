import "reflect-metadata";
import AuthService from "../auth.service";
import UserRepo from "../repositories/user.repo";
import { User } from "../model/user.model";
import { DEMO_USERNAME } from "../demo-account";

function makeService(findByUsername: jest.Mock): AuthService {
  return new AuthService({ findByUsername } as unknown as UserRepo);
}

function demoRow(overrides: Partial<User> = {}): User {
  return { id: "u1", username: DEMO_USERNAME, isActive: true, ...overrides } as User;
}

describe("AuthService.signInOptions", () => {
  afterEach(() => {
    delete process.env.DEMO_CREDENTIALS_URL;
  });

  it("reports no demo account when the seed never ran", async () => {
    const service = makeService(jest.fn().mockResolvedValue(undefined));
    await expect(service.signInOptions()).resolves.toEqual({ demoAccount: null });
  });

  it("reports no demo account when the row exists but is deactivated", async () => {
    const service = makeService(jest.fn().mockResolvedValue(demoRow({ isActive: false })));
    await expect(service.signInOptions()).resolves.toEqual({ demoAccount: null });
  });

  it("reports the demo account with its published-credentials link", async () => {
    process.env.DEMO_CREDENTIALS_URL = "https://ojuri.io/#sandbox";
    const service = makeService(jest.fn().mockResolvedValue(demoRow()));

    await expect(service.signInOptions()).resolves.toEqual({
      demoAccount: { username: DEMO_USERNAME, credentialsUrl: "https://ojuri.io/#sandbox" },
    });
  });

  it("drops a credentials URL that is not http(s)", async () => {
    process.env.DEMO_CREDENTIALS_URL = "javascript:alert(1)";
    const service = makeService(jest.fn().mockResolvedValue(demoRow()));

    const { demoAccount } = await service.signInOptions();
    expect(demoAccount?.credentialsUrl).toBeNull();
  });

  it("serves an anonymous route, so repeated calls hit the database once", async () => {
    const findByUsername = jest.fn().mockResolvedValue(demoRow());
    const service = makeService(findByUsername);

    await service.signInOptions();
    await service.signInOptions();

    expect(findByUsername).toHaveBeenCalledTimes(1);
  });
});
