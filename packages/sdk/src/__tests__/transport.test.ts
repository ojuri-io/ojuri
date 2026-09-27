import { readFileSync } from "node:fs";
import path from "node:path";
import util from "node:util";
import OjuriClient from "../client.js";
import OjuriApiError from "../errors/api.error.js";
import OjuriConfigurationError from "../errors/configuration.error.js";
import OjuriError from "../errors/ojuri.error.js";
import OjuriNetworkError from "../errors/network.error.js";
import OjuriTimeoutError from "../errors/timeout.error.js";
import { backoffDelayMs, isRetryable, parseRetryAfter, sleep } from "../http/retry.js";
import { SDK_VERSION } from "../version.js";
import { PredictRequest } from "../types/predict.types.js";
import { stubFetch } from "./test-fetch.js";

const REQUEST: PredictRequest = {
  transaction_id: "txn-0000000001",
  sender_id: "a",
  receiver_id: "b",
  amount: 1,
  transaction_type: "TRANSFER",
  timestamp: 1735689600000,
};

const DECISION = { transaction_id: REQUEST.transaction_id, decision: "ACCEPT", fraud: false };
const KEY = { idempotencyKey: "txn-0000000001" };

function client(stubs: Parameters<typeof stubFetch>[0], overrides = {}) {
  const stub = stubFetch(stubs);
  return {
    stub,
    sdk: new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: "fdk_x_y",
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
      ...overrides,
    }),
  };
}

describe("retries", () => {
  it("stops after maxRetries and throws the last error", async () => {
    const { sdk, stub } = client([{ status: 503, body: { status: false, message: "down" } }], {
      maxRetries: 3,
    });

    await expect(sdk.predict(REQUEST, KEY)).rejects.toBeInstanceOf(OjuriApiError);
    expect(stub.calls).toHaveLength(4);
  });

  it("wraps a fetch rejection as a network error and retries it", async () => {
    const { sdk, stub } = client([new Error("ECONNREFUSED"), { body: DECISION }]);

    await expect(sdk.predict(REQUEST, KEY)).resolves.toMatchObject({ replayed: false });
    expect(stub.calls).toHaveLength(2);
  });

  it.each([408, 429, 502, 503, 504])("retries %i", (status) => {
    expect(isRetryable(new OjuriApiError("x", { status }))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422, 500])("does not retry %i", (status) => {
    expect(isRetryable(new OjuriApiError("x", { status }))).toBe(false);
  });

  it("lets Retry-After promote a 4xx but never a 500", () => {
    expect(isRetryable(new OjuriApiError("x", { status: 409, retryAfterSeconds: 1 }))).toBe(true);
    expect(isRetryable(new OjuriApiError("x", { status: 500, retryAfterSeconds: 1 }))).toBe(false);
  });

  it("caps jittered backoff at the doubling ceiling", () => {
    expect(backoffDelayMs(3, 100, null, () => 1)).toBe(800);
    expect(backoffDelayMs(3, 100, null, () => 0)).toBe(0);
  });
});

describe("Retry-After", () => {
  it.each([
    [null, null],
    ["-5", 0],
    ["2", 2],
    ["soon", null],
  ])("parses %p as %p", (raw, expected) => {
    expect(parseRetryAfter(raw as string | null)).toBe(expected);
  });

  it("reads the HTTP-date form and clamps a past date", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now + 60_000)).toBe(0);
  });

  it("honours the server's figure rather than truncating it", () => {
    expect(backoffDelayMs(0, 200, 60)).toBe(60_000);
  });

  it("gives up instead of retrying earlier than the server instructed", async () => {
    const { sdk, stub } = client(
      [{ status: 429, body: { status: false, message: "slow down" }, headers: { "Retry-After": "60" } }],
      { maxRetries: 2, timeoutMs: 10_000 }
    );

    const err = await sdk.predict(REQUEST, KEY).catch((e) => e);

    expect(err).toBeInstanceOf(OjuriApiError);
    expect(err.retryAfterSeconds).toBe(60);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("deadline", () => {
  it("stops retrying once the wall-clock budget is spent", async () => {
    const { sdk, stub } = client(
      [{ status: 503, body: { status: false, message: "down" }, headers: { "Retry-After": "30" } }],
      { maxRetries: 5, deadlineMs: 50 }
    );

    await expect(sdk.predict(REQUEST, KEY)).rejects.toBeInstanceOf(OjuriApiError);
    expect(stub.calls).toHaveLength(1);
  });

  it("caps a per-attempt timeout at the remaining budget", async () => {
    const sdk = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: "k",
      timeoutMs: 60_000,
      deadlineMs: 20,
      maxRetries: 0,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });

    await expect(sdk.predict(REQUEST)).rejects.toBeInstanceOf(OjuriTimeoutError);
  }, 2000);
});

describe("cancellation", () => {
  it("never sends when the signal is already aborted", async () => {
    const { sdk, stub } = client([{ body: DECISION }]);
    const controller = new AbortController();
    controller.abort();

    await expect(sdk.predict(REQUEST, { signal: controller.signal })).rejects.toBeDefined();
    expect(stub.calls).toHaveLength(0);
  });

  it("stops retrying when the caller aborts during backoff", async () => {
    const { sdk, stub } = client([{ status: 503, body: { status: false, message: "down" } }], {
      maxRetries: 5,
      retryBaseDelayMs: 30_000,
    });
    const controller = new AbortController();

    const pending = sdk.predict(REQUEST, { ...KEY, signal: controller.signal });
    await Promise.resolve();
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toBeDefined();
    expect(stub.calls).toHaveLength(1);
  }, 1000);

  it("normalises a non-Error abort reason to an AbortError", async () => {
    const { sdk } = client([{ body: DECISION }]);
    const controller = new AbortController();
    controller.abort("operator cancelled");

    const err = await sdk.predict(REQUEST, { signal: controller.signal }).catch((e) => e);

    expect(err.name).toBe("AbortError");
  });

  it("preserves an Error reason as given", async () => {
    const { sdk } = client([{ body: DECISION }]);
    const controller = new AbortController();
    const reason = new Error("superseded");
    controller.abort(reason);

    await expect(sdk.predict(REQUEST, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("resolves sleep promptly when the signal aborts mid-delay", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);

    await sleep(30_000, controller.signal);

    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it("resolves sleep immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();

    await sleep(30_000, controller.signal);

    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);
});

describe("errors", () => {
  it("identifies its own errors without instanceof", () => {
    const err = new OjuriApiError("boom", { status: 500 });

    expect(OjuriError.isOjuriError(err)).toBe(true);
    expect(OjuriApiError.isOjuriApiError(err)).toBe(true);
    expect(OjuriApiError.isOjuriApiError(new Error("plain"))).toBe(false);
  });

  it("truncates a huge string error body", async () => {
    const sdk = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: "k",
      maxRetries: 0,
      fetch: async () => new Response("x".repeat(50_000), { status: 400 }),
    });

    const err = await sdk.predict(REQUEST).catch((e) => e);

    expect(err.body.length).toBeLessThan(10_000);
  });

  it("truncates a huge JSON error body", async () => {
    const { sdk } = client([
      {
        status: 400,
        body: { status: false, message: "failed", errors: Array(50_000).fill("field invalid") },
      },
    ]);

    const err = await sdk.predict(REQUEST).catch((e) => e);

    expect(JSON.stringify(err.body).length).toBeLessThan(10_000);
  });

  it("surfaces a bare {error} body as the message", async () => {
    const { sdk } = client([{ status: 404, body: { error: "not found" } }]);

    await expect(sdk.predict(REQUEST)).rejects.toMatchObject({ status: 404, message: "not found" });
  });
});

describe("configuration", () => {
  it.each([["rda.example.com"], ["ftp://rda.example.com"], [""]])(
    "refuses the baseUrl %p",
    (baseUrl) => {
      expect(() => new OjuriClient({ baseUrl })).toThrow(OjuriConfigurationError);
    }
  );

  it("keeps the api key out of every serialisation route", () => {
    const secret = "fdk_live_SECRETVALUE";
    const sdk = new OjuriClient({ baseUrl: "https://rda.example.com", apiKey: secret });

    expect(JSON.stringify(sdk)).not.toContain(secret);
    expect(util.inspect(sdk, { depth: null, showHidden: true })).not.toContain(secret);
    expect(JSON.stringify(Object.values(sdk))).not.toContain(secret);
  });

  it("reports a version matching package.json", () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("does not classify a client-side failure as a network error", async () => {
    const { sdk } = client([{ body: DECISION }]);

    await expect(sdk.predict({ ...REQUEST, transaction_id: "s" })).rejects.not.toBeInstanceOf(
      OjuriNetworkError
    );
  });
});
