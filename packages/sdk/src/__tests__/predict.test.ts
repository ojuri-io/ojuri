import OjuriClient from "../client.js";
import OjuriApiError from "../errors/api.error.js";
import OjuriValidationError from "../errors/validation.error.js";
import { Decision, DecisionSource } from "../index.js";
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
  reason_codes: [],
  model_version: "v1.0",
  threshold: 0.65,
  latency_ms: 4,
  timestamp: REQUEST.timestamp,
};

describe("predict", () => {
  it("posts to /v1/predict with the API key and returns the raw decision", async () => {
    const stub = stubFetch([{ body: DECISION, headers: { "X-Correlation-ID": "req-abc" } }]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: "fdk_pfx_secret",
      tenantId: "acme",
      fetch: stub.fetch,
    });

    const result = await client.predict(REQUEST);

    expect(result.decision.decision).toBe("ACCEPT");
    expect(result.replayed).toBe(false);
    expect(result.correlationId).toBe("req-abc");

    const call = stub.calls[0]!;
    expect(call.url).toBe("https://rda.example.com/v1/predict");
    expect(headerOf(call, "X-Api-Key")).toBe("fdk_pfx_secret");
    expect(headerOf(call, "X-Tenant-ID")).toBe("acme");
    expect(JSON.parse(call.init.body as string)).toEqual(REQUEST);
  });

  it("reuses one generated Idempotency-Key across retries", async () => {
    const stub = stubFetch([
      { status: 503, body: { status: false, message: "unavailable" }, headers: { "Retry-After": "0" } },
      { body: DECISION },
    ]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
    });

    await client.predict(REQUEST);

    expect(stub.calls).toHaveLength(2);
    const first = headerOf(stub.calls[0]!, "Idempotency-Key");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(headerOf(stub.calls[1]!, "Idempotency-Key")).toBe(first);
  });

  it("omits the generated key when autoIdempotencyKey is off", async () => {
    const stub = stubFetch([{ body: DECISION }]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      autoIdempotencyKey: false,
      fetch: stub.fetch,
    });

    await client.predict(REQUEST);

    expect(headerOf(stub.calls[0]!, "Idempotency-Key")).toBeUndefined();
  });

  it("flags a replayed response", async () => {
    const stub = stubFetch([{ body: DECISION, headers: { "Idempotency-Replay": "true" } }]);
    const client = new OjuriClient({ baseUrl: "https://rda.example.com", fetch: stub.fetch });

    const result = await client.predict(REQUEST, { idempotencyKey: "key-1" });

    expect(result.replayed).toBe(true);
  });

  it("rejects an over-long idempotency key before sending", async () => {
    const stub = stubFetch([{ body: DECISION }]);
    const client = new OjuriClient({ baseUrl: "https://rda.example.com", fetch: stub.fetch });

    await expect(client.predict(REQUEST, { idempotencyKey: "x".repeat(129) })).rejects.toBeInstanceOf(
      OjuriValidationError
    );
    expect(stub.calls).toHaveLength(0);
  });

  it("surfaces a duplicate transaction as a non-retried 409", async () => {
    const stub = stubFetch([
      { status: 409, body: { status: false, message: 'transaction_id "txn-1" already processed' } },
    ]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
    });

    await expect(client.predict(REQUEST)).rejects.toMatchObject({
      name: "OjuriApiError",
      status: 409,
      message: expect.stringContaining("already processed"),
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("retries a 409 that carries Retry-After (in-flight key)", async () => {
    const stub = stubFetch([
      { status: 409, body: { status: false, message: "still in flight" }, headers: { "Retry-After": "0" } },
      { body: DECISION },
    ]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
    });

    await expect(client.predict(REQUEST)).resolves.toMatchObject({ replayed: false });
    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry a 422 body divergence", async () => {
    const stub = stubFetch([
      { status: 422, body: { status: false, message: "Idempotency-Key reused with a different request body" } },
    ]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
    });

    const error = await client.predict(REQUEST).catch((err) => err);
    expect(error).toBeInstanceOf(OjuriApiError);
    expect(error.status).toBe(422);
    expect(stub.calls).toHaveLength(1);
  });
});
