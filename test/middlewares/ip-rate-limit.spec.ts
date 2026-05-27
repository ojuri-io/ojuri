import "reflect-metadata";
import { ipRateLimit } from "../../src/shared/middlewares/ip-rate-limit.middleware";

// Helper to build a minimal Fastify-shaped req/res so we can drive the
// middleware in isolation. The real Fastify types are noisy here; the
// `as never` casts keep the test focused on the contract.
function buildReq(overrides: { ip?: string; xff?: string } = {}) {
  return {
    ip: overrides.ip ?? "127.0.0.1",
    headers: overrides.xff ? { "x-forwarded-for": overrides.xff } : {},
  } as never;
}

function buildRes() {
  const calls: { code?: number; headers: Record<string, string>; body?: unknown } = {
    headers: {},
  };
  const res = {
    code(c: number) {
      calls.code = c;
      return res;
    },
    header(k: string, v: string) {
      calls.headers[k] = v;
      return res;
    },
    send(b: unknown) {
      calls.body = b;
      return res;
    },
  };
  return { res: res as never, calls };
}

describe("ipRateLimit", () => {
  it("lets the first N requests through and 429s the (N+1)th", async () => {
    // Use a high label suffix so other tests don't share state.
    const limit = ipRateLimit({ ratePerMinute: 3, routeLabel: "test.boundary" });

    const ip = "10.0.0.1";
    for (let i = 0; i < 3; i++) {
      const { res, calls } = buildRes();
      await limit(buildReq({ ip }), res);
      expect(calls.code).toBeUndefined();
    }

    const { res, calls } = buildRes();
    await limit(buildReq({ ip }), res);
    expect(calls.code).toBe(429);
    expect(calls.headers["Retry-After"]).toBe("60");
    expect(calls.body).toMatchObject({ status: false });
  });

  it("isolates buckets per IP", async () => {
    const limit = ipRateLimit({ ratePerMinute: 2, routeLabel: "test.isolation" });

    for (let i = 0; i < 2; i++) {
      const { res, calls } = buildRes();
      await limit(buildReq({ ip: "10.0.0.2" }), res);
      expect(calls.code).toBeUndefined();
    }
    // Same route, different IP — should NOT be rate-limited.
    const { res, calls } = buildRes();
    await limit(buildReq({ ip: "10.0.0.3" }), res);
    expect(calls.code).toBeUndefined();
  });

  it("isolates buckets per routeLabel", async () => {
    const limitA = ipRateLimit({ ratePerMinute: 1, routeLabel: "route.A" });
    const limitB = ipRateLimit({ ratePerMinute: 1, routeLabel: "route.B" });
    const ip = "10.0.0.4";

    await limitA(buildReq({ ip }), buildRes().res);
    // A is exhausted; B still has its own bucket.
    const { res, calls } = buildRes();
    await limitB(buildReq({ ip }), res);
    expect(calls.code).toBeUndefined();
  });

  it("prefers the first X-Forwarded-For hop over req.ip", async () => {
    const limit = ipRateLimit({ ratePerMinute: 1, routeLabel: "test.xff" });

    // Two requests, same XFF chain — should rate-limit the second.
    const xff = "192.0.2.50, 198.51.100.7";
    const { res: res1 } = buildRes();
    await limit(buildReq({ ip: "127.0.0.1", xff }), res1);
    const { res: res2, calls: calls2 } = buildRes();
    await limit(buildReq({ ip: "127.0.0.1", xff }), res2);
    expect(calls2.code).toBe(429);

    // Different XFF hop, same socket IP — should NOT be rate-limited.
    const { res: res3, calls: calls3 } = buildRes();
    await limit(buildReq({ ip: "127.0.0.1", xff: "203.0.113.99" }), res3);
    expect(calls3.code).toBeUndefined();
  });

  it("env var overrides the inline default", async () => {
    process.env.TEST_OVERRIDE_RATE = "2";
    const limit = ipRateLimit({
      ratePerMinute: 100, // ignored
      envKey: "TEST_OVERRIDE_RATE",
      routeLabel: "test.env",
    });

    const ip = "10.0.0.5";
    for (let i = 0; i < 2; i++) {
      const { res, calls } = buildRes();
      await limit(buildReq({ ip }), res);
      expect(calls.code).toBeUndefined();
    }
    const { res, calls } = buildRes();
    await limit(buildReq({ ip }), res);
    expect(calls.code).toBe(429);

    delete process.env.TEST_OVERRIDE_RATE;
  });
});
