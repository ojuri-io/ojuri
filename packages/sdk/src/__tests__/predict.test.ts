import OjuriClient from "../client.js";
import OjuriApiError from "../errors/api.error.js";
import OjuriResponseError from "../errors/response.error.js";
import OjuriValidationError from "../errors/validation.error.js";
import { Decision, DecisionSource, ReasonBasis } from "../index.js";
import { PredictRequest } from "../types/predict.types.js";
import { headerOf, stubFetch } from "./test-fetch.js";

const REQUEST: PredictRequest = {
  transaction_id: "txn-0000000001",
  sender_id: "acct-123",
  receiver_id: "acct-456",
  amount: 50000,
  transaction_type: "TRANSFER",
  timestamp: 1735689600000,
};

const DECISION = {
  transaction_id: REQUEST.transaction_id,
  fraud: false,
  fraud_probability: 0.12,
  decision: Decision.ACCEPT,
  decision_source: DecisionSource.ML,
  reason_codes: [
    { code: "AMT_HIGH", description: "", contribution: 0.1, value: 1, basis: ReasonBasis.MODEL_WEIGHTED },
  ],
  model_version: "v1.0",
  threshold: 0.65,
  latency_ms: 4,
  timestamp: REQUEST.timestamp,
};

function client(stubs: Parameters<typeof stubFetch>[0], overrides = {}) {
  const stub = stubFetch(stubs);
  return {
    stub,
    sdk: new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: "fdk_pfx_secret",
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
      ...overrides,
    }),
  };
}

describe("predict", () => {
  it("posts to /v1/predict with the API key and returns the raw decision", async () => {
    const { sdk, stub } = client([{ body: DECISION, headers: { "X-Correlation-ID": "req-abc" } }], {
      tenantId: "acme",
    });

    const result = await sdk.predict(REQUEST);

    expect(result.decision.decision).toBe("ACCEPT");
    expect(result.decision.reason_codes[0]!.basis).toBe("MODEL_WEIGHTED");
    expect(result.replayed).toBe(false);
    expect(result.correlationId).toBe("req-abc");

    const call = stub.calls[0]!;
    expect(call.url).toBe("https://rda.example.com/v1/predict");
    expect(headerOf(call, "X-Api-Key")).toBe("fdk_pfx_secret");
    expect(headerOf(call, "X-Tenant-ID")).toBe("acme");
    expect(headerOf(call, "Authorization")).toBeUndefined();
    expect(JSON.parse(call.init.body as string)).toEqual(REQUEST);
  });

  it("sends no Idempotency-Key by default", async () => {
    const { sdk, stub } = client([{ body: DECISION }]);

    await sdk.predict(REQUEST);

    expect(headerOf(stub.calls[0]!, "Idempotency-Key")).toBeUndefined();
  });

  it("does not retry when no key was sent", async () => {
    const { sdk, stub } = client([{ status: 503, body: { status: false, message: "down" } }]);

    await expect(sdk.predict(REQUEST)).rejects.toBeInstanceOf(OjuriApiError);
    expect(stub.calls).toHaveLength(1);
  });

  it("reuses the caller's key across retries", async () => {
    const { sdk, stub } = client([
      { status: 503, body: { status: false, message: "down" }, headers: { "Retry-After": "0" } },
      { body: DECISION },
    ]);

    await sdk.predict(REQUEST, { idempotencyKey: REQUEST.transaction_id });

    expect(stub.calls).toHaveLength(2);
    expect(headerOf(stub.calls[0]!, "Idempotency-Key")).toBe(REQUEST.transaction_id);
    expect(headerOf(stub.calls[1]!, "Idempotency-Key")).toBe(REQUEST.transaction_id);
  });

  it("reuses one generated key across retries when asked to generate", async () => {
    const { sdk, stub } = client(
      [{ status: 503, body: { status: false, message: "down" } }, { body: DECISION }],
      { autoIdempotencyKey: true }
    );

    await sdk.predict(REQUEST);

    const first = headerOf(stub.calls[0]!, "Idempotency-Key");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(headerOf(stub.calls[1]!, "Idempotency-Key")).toBe(first);
  });

  it("flags a replayed response", async () => {
    const { sdk } = client([{ body: DECISION, headers: { "Idempotency-Replay": "true" } }]);

    const result = await sdk.predict(REQUEST, { idempotencyKey: "key-1" });

    expect(result.replayed).toBe(true);
  });

  it("surfaces a duplicate transaction as a non-retried 409", async () => {
    const { sdk, stub } = client([
      { status: 409, body: { status: false, message: 'transaction_id "txn-1" already processed' } },
    ]);

    await expect(sdk.predict(REQUEST, { idempotencyKey: "k" })).rejects.toMatchObject({
      name: "OjuriApiError",
      status: 409,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("retries a 409 that carries Retry-After (in-flight key)", async () => {
    const { sdk, stub } = client([
      { status: 409, body: { status: false, message: "in flight" }, headers: { "Retry-After": "0" } },
      { body: DECISION },
    ]);

    await sdk.predict(REQUEST, { idempotencyKey: "k" });

    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry a 422 body divergence", async () => {
    const { sdk, stub } = client([
      { status: 422, body: { status: false, message: "Idempotency-Key reused" } },
    ]);

    await expect(sdk.predict(REQUEST, { idempotencyKey: "k" })).rejects.toMatchObject({ status: 422 });
    expect(stub.calls).toHaveLength(1);
  });
});

describe("predict input validation", () => {
  it.each([["short"], [""], ["x".repeat(256)]])(
    "rejects transaction_id %p before sending",
    async (transaction_id) => {
      const { sdk, stub } = client([{ body: DECISION }]);

      await expect(sdk.predict({ ...REQUEST, transaction_id })).rejects.toBeInstanceOf(
        OjuriValidationError
      );
      expect(stub.calls).toHaveLength(0);
    }
  );

  it.each([["with\r\nX-Injected: evil"], ["x".repeat(129)], [""]])(
    "rejects idempotencyKey %p before sending",
    async (idempotencyKey) => {
      const { sdk, stub } = client([{ body: DECISION }], { maxRetries: 3 });

      await expect(sdk.predict(REQUEST, { idempotencyKey })).rejects.toBeInstanceOf(
        OjuriValidationError
      );
      expect(stub.calls).toHaveLength(0);
    }
  );

  it.each([["with\rnewline"], ["x".repeat(252)]])(
    "rejects correlationId %p before sending",
    async (correlationId) => {
      const { sdk, stub } = client([{ body: DECISION }], { maxRetries: 3 });

      await expect(sdk.predict(REQUEST, { correlationId })).rejects.toBeInstanceOf(
        OjuriValidationError
      );
      expect(stub.calls).toHaveLength(0);
    }
  );

  it("accepts a correlationId at the server's usable limit", async () => {
    const { sdk, stub } = client([{ body: DECISION }]);

    await sdk.predict(REQUEST, { correlationId: "x".repeat(251) });

    expect(stub.calls).toHaveLength(1);
  });

  it.each([["with\r\nevil"], ["x".repeat(513)]])(
    "refuses to construct a client with apiKey %p",
    (apiKey) => {
      expect(() => new OjuriClient({ baseUrl: "https://rda.example.com", apiKey })).toThrow(
        OjuriValidationError
      );
    }
  );

  it("rejects a body that cannot be serialised without sending", async () => {
    const { sdk, stub } = client([{ body: DECISION }], { maxRetries: 4 });
    const hostile = { ...REQUEST, amount: 1n as unknown as number };

    await expect(sdk.predict(hostile)).rejects.toBeInstanceOf(OjuriValidationError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("predict response validation", () => {
  it("refuses a 200 that is not JSON instead of resolving with a string", async () => {
    const sdk = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: "k",
      fetch: async () =>
        new Response("<html><body>Access Denied</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    });

    await expect(sdk.predict(REQUEST)).rejects.toBeInstanceOf(OjuriResponseError);
  });

  it("refuses a JSON 200 with no decision field", async () => {
    const { sdk } = client([{ body: { unexpected: true } }]);

    await expect(sdk.predict(REQUEST)).rejects.toBeInstanceOf(OjuriResponseError);
  });
});
