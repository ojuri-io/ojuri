import OjuriClient from "../client.js";
import OjuriApiError from "../errors/api.error.js";
import OjuriError from "../errors/ojuri.error.js";
import OjuriResponseError from "../errors/response.error.js";
import OjuriTimeoutError from "../errors/timeout.error.js";
import OjuriValidationError from "../errors/validation.error.js";
import { sleep } from "../http/retry.js";
import { SDK_VERSION } from "../version.js";
import { PredictRequest } from "../types/predict.types.js";
import { stubFetch } from "./test-fetch.js";

const REQUEST: PredictRequest = {
  transaction_id: "txn-0000000001",
  sender_id: "acct-123",
  receiver_id: "acct-456",
  amount: 50000,
  transaction_type: "TRANSFER",
  timestamp: 1735689600000,
};

const DECISION = { transaction_id: REQUEST.transaction_id, decision: "ACCEPT", fraud: false };

function client(stubs: Parameters<typeof stubFetch>[0], overrides = {}) {
  const stub = stubFetch(stubs);
  return {
    stub,
    sdk: new OjuriClient({
      baseUrl: "https://rda.example.com",
      fiaUrl: "https://fia.example.com",
      apiKey: "fdk_x_y",
      jwt: "jwt-token",
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
      ...overrides,
    }),
  };
}

describe("non-JSON responses", () => {
  it("refuses a 200 that is not JSON instead of resolving with a string", async () => {
    const stub = stubFetch([
      { body: undefined, headers: { "Content-Type": "text/html" } },
    ]);
    const sdk = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: "k",
      fetch: async () =>
        new Response("<html><body>Access Denied</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    });
    void stub;

    await expect(sdk.predict(REQUEST)).rejects.toBeInstanceOf(OjuriResponseError);
  });

  it("refuses a JSON 200 with no decision field", async () => {
    const { sdk } = client([{ body: { unexpected: true } }]);

    await expect(sdk.predict(REQUEST)).rejects.toBeInstanceOf(OjuriResponseError);
  });

  it("refuses a login response with no token, leaving auth unchanged", async () => {
    const { sdk, stub } = client([{ body: { status: true, message: "Logged in", data: {} } }]);

    await expect(sdk.login({ username: "admin", password: "pw" })).rejects.toBeInstanceOf(
      OjuriResponseError
    );
    expect(stub.calls).toHaveLength(1);
  });

  it.each([[42], [{ nested: true }], [null]])(
    "refuses a non-string token %p",
    async (token) => {
      const { sdk } = client([{ body: { status: true, data: { token } } }]);

      await expect(sdk.login({ username: "a", password: "b" })).rejects.toBeInstanceOf(
        OjuriResponseError
      );
    }
  );
});

describe("write replay", () => {
  it("does not retry an override", async () => {
    const { sdk, stub } = client([{ status: 503, body: { status: false, message: "down" } }]);

    await expect(sdk.decisions.override("audit-1", { decision: "ACCEPT" })).rejects.toBeInstanceOf(
      OjuriApiError
    );
    expect(stub.calls).toHaveLength(1);
  });

  it("does not retry a report message", async () => {
    const { sdk, stub } = client([{ status: 503, body: { error: "busy" } }]);

    await expect(sdk.reports!.message("rpt-1", "why?")).rejects.toBeInstanceOf(OjuriApiError);
    expect(stub.calls).toHaveLength(1);
  });

  it("does not retry a login", async () => {
    const { sdk, stub } = client([{ status: 503, body: { status: false, message: "down" } }]);

    await expect(sdk.login({ username: "a", password: "b" })).rejects.toBeInstanceOf(OjuriApiError);
    expect(stub.calls).toHaveLength(1);
  });

  it("still retries reads and idempotent writes", async () => {
    const { sdk, stub } = client([
      { status: 503, body: { status: false, message: "down" } },
      { body: { status: true, data: [] } },
    ]);

    await sdk.decisions.recent();

    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry a predict sent without an idempotency key", async () => {
    const { sdk, stub } = client(
      [{ status: 503, body: { status: false, message: "down" } }],
      { autoIdempotencyKey: false }
    );

    await expect(sdk.predict(REQUEST)).rejects.toBeInstanceOf(OjuriApiError);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("deadline budget", () => {
  it("stops retrying once the wall-clock budget is spent", async () => {
    const { sdk, stub } = client(
      [{ status: 503, body: { status: false, message: "down" }, headers: { "Retry-After": "30" } }],
      { maxRetries: 5, deadlineMs: 50 }
    );

    await expect(sdk.predict(REQUEST)).rejects.toBeInstanceOf(OjuriApiError);
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

  it("lets an explicit client timeout win over the LLM default", async () => {
    const { sdk, stub } = client([{ body: { id: "rpt-1" } }], { timeoutMs: 1234 });

    await sdk.reports!.create({ transaction_id: "txn-1" });

    expect(stub.calls).toHaveLength(1);
  });
});

describe("client-side failures are not network errors", () => {
  it("rejects a body that cannot be serialised without sending", async () => {
    const { sdk, stub } = client([{ body: DECISION }], { maxRetries: 4 });
    const hostile = { ...REQUEST, amount: 1n as unknown as number };

    await expect(sdk.predict(hostile)).rejects.toBeInstanceOf(OjuriValidationError);
    expect(stub.calls).toHaveLength(0);
  });

  it.each([["with\rnewline"], ["with\nnewline"], ["x".repeat(513)]])(
    "rejects the correlationId %p without sending",
    async (correlationId) => {
      const { sdk, stub } = client([{ body: DECISION }], { maxRetries: 4 });

      await expect(sdk.predict(REQUEST, { correlationId })).rejects.toBeInstanceOf(
        OjuriValidationError
      );
      expect(stub.calls).toHaveLength(0);
    }
  );

  it("rejects a tenantId with control characters", async () => {
    const { sdk, stub } = client([{ body: { status: true, data: [] } }]);

    await expect(sdk.decisions.recent({}, { tenantId: "acme\r\nX: y" })).rejects.toBeInstanceOf(
      OjuriValidationError
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe("abort normalisation", () => {
  it("throws an AbortError even when abort() was given a plain string", async () => {
    const { sdk } = client([{ body: DECISION }]);
    const controller = new AbortController();
    controller.abort("operator cancelled");

    const err = await sdk.predict(REQUEST, { signal: controller.signal }).catch((e) => e);

    expect(err.name).toBe("AbortError");
    expect(typeof err.message).toBe("string");
  });

  it("preserves an Error reason as given", async () => {
    const { sdk } = client([{ body: DECISION }]);
    const controller = new AbortController();
    const reason = new Error("superseded");
    controller.abort(reason);

    await expect(sdk.predict(REQUEST, { signal: controller.signal })).rejects.toBe(reason);
  });
});

describe("sleep", () => {
  it("resolves promptly when the signal aborts mid-delay", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);

    await sleep(30_000, controller.signal);

    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it("resolves immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();

    await sleep(30_000, controller.signal);

    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);
});

describe("cross-realm error identification", () => {
  it("identifies its own errors without instanceof", () => {
    const err = new OjuriApiError("boom", { status: 500 });

    expect(OjuriError.isOjuriError(err)).toBe(true);
    expect(OjuriApiError.isOjuriApiError(err)).toBe(true);
    expect(OjuriApiError.isOjuriApiError(new Error("plain"))).toBe(false);
  });

  it("identifies an error carried across a module realm boundary", () => {
    const foreign = { name: "OjuriApiError", [Symbol.for("ojuri.sdk.error")]: true };

    expect(OjuriApiError.isOjuriApiError(foreign)).toBe(true);
  });
});

describe("error payload retention", () => {
  it("truncates a huge string error body", async () => {
    const { sdk } = client([{ status: 400, body: undefined }]);
    void sdk;
    const huge = "x".repeat(50_000);
    const sdk2 = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: "k",
      maxRetries: 0,
      fetch: async () => new Response(huge, { status: 400 }),
    });

    const err = await sdk2.predict(REQUEST).catch((e) => e);

    expect(typeof err.body).toBe("string");
    expect(err.body.length).toBeLessThan(10_000);
  });
});

describe("version", () => {
  it("matches package.json", () => {
    expect(SDK_VERSION).toBe(require("../../package.json").version);
  });
});
