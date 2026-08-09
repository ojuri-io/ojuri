import LeaderLeaseService from "../leader-lease.service";

const redis = {
  store: new Map<string, string>(),
  failNext: null as string | null,
  set: jest.fn(),
  get: jest.fn(),
  eval: jest.fn(),
};

jest.mock("../redis-client", () => ({
  redisClient: { get: () => redis },
}));

jest.mock("@config/app.config", () => {
  const actual = jest.requireActual("@config/app.config").default;
  return { __esModule: true, default: { ...actual, paa: { ...actual.paa, leaderLeaseTtlMs: 300 } } };
});

function reset() {
  redis.store.clear();
  redis.failNext = null;

  redis.set.mockImplementation(async (key: string, value: string) => {
    if (redis.failNext) throw new Error(redis.failNext);
    if (redis.store.has(key)) return null;
    redis.store.set(key, value);
    return "OK";
  });

  redis.get.mockImplementation(async (key: string) => redis.store.get(key) ?? null);

  // Both Lua scripts are CAS-by-value: act only if we still own the key.
  redis.eval.mockImplementation(async (script: string, _n: number, key: string, id: string) => {
    if (redis.failNext) throw new Error(redis.failNext);
    if (redis.store.get(key) !== id) return 0;
    if (script.includes("del")) redis.store.delete(key);
    return 1;
  });
}

beforeEach(reset);

describe("acquiring the lease", () => {
  it("grants the lease to the first instance only", async () => {
    const first = new LeaderLeaseService();
    const second = new LeaderLeaseService();

    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(second.isHeld()).toBe(false);
  });

  it("fails closed when Redis is unreachable", async () => {
    redis.failNext = "connection refused";
    const lease = new LeaderLeaseService();

    expect(await lease.acquire()).toBe(false);
    expect(lease.isHeld()).toBe(false);
  });

  it("takes over once the incumbent releases, instead of exiting on the first refusal", async () => {
    const incumbent = new LeaderLeaseService();
    const successor = new LeaderLeaseService();
    await incumbent.acquire();

    setTimeout(() => void incumbent.release(), 50);

    expect(await successor.acquireWithRetry(3000)).toBe(true);
  });

  it("gives up once the timeout passes", async () => {
    const incumbent = new LeaderLeaseService();
    await incumbent.acquire();

    expect(await new LeaderLeaseService().acquireWithRetry(20)).toBe(false);
  });
});

describe("losing the lease", () => {
  it("surrenders when another instance already holds the key", async () => {
    const lease = new LeaderLeaseService();
    await lease.acquire();

    redis.store.set("ojuri:paa:leader", "someone-else");
    const onLost = jest.fn();
    lease.startRenewal(onLost);

    await new Promise((r) => setTimeout(r, 250));

    expect(lease.isHeld()).toBe(false);
    expect(onLost).toHaveBeenCalled();
  });

  // The failure this guards: a partition that outlasts the TTL expires
  // the key server-side and lets a challenger in, so treating an
  // unreachable Redis as "still the leader" is split brain.
  it("surrenders when renewal stays unreachable past the lease TTL", async () => {
    const lease = new LeaderLeaseService();
    await lease.acquire();

    const onLost = jest.fn();
    lease.startRenewal(onLost);
    redis.failNext = "connection reset";

    await new Promise((r) => setTimeout(r, 500));

    expect(lease.isHeld()).toBe(false);
    expect(onLost).toHaveBeenCalled();
  });

  it("keeps the lease through a renewal blip shorter than the TTL", async () => {
    const lease = new LeaderLeaseService();
    await lease.acquire();

    const onLost = jest.fn();
    lease.startRenewal(onLost);
    redis.failNext = "timeout";
    await new Promise((r) => setTimeout(r, 120));
    redis.failNext = null;
    await new Promise((r) => setTimeout(r, 200));

    expect(lease.isHeld()).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("reports loss only once", async () => {
    const lease = new LeaderLeaseService();
    await lease.acquire();
    redis.store.set("ojuri:paa:leader", "someone-else");

    const onLost = jest.fn();
    lease.startRenewal(onLost);
    await new Promise((r) => setTimeout(r, 400));

    expect(onLost).toHaveBeenCalledTimes(1);
  });
});

describe("releasing the lease", () => {
  it("frees the key so a successor can take over immediately", async () => {
    const lease = new LeaderLeaseService();
    await lease.acquire();
    await lease.release();

    expect(redis.store.has("ojuri:paa:leader")).toBe(false);
    expect(await new LeaderLeaseService().acquire()).toBe(true);
  });

  it("never deletes a lease another instance now holds", async () => {
    const lease = new LeaderLeaseService();
    await lease.acquire();
    redis.store.set("ojuri:paa:leader", "someone-else");

    await lease.release();

    expect(redis.store.get("ojuri:paa:leader")).toBe("someone-else");
  });

  it("is a no-op when the lease was never held", async () => {
    await expect(new LeaderLeaseService().release()).resolves.toBeUndefined();
  });
});
