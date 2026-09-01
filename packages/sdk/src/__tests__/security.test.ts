import OjuriClient from "../client.js";
import OjuriApiError from "../errors/api.error.js";
import OjuriValidationError from "../errors/validation.error.js";
import { isRetryable, parseRetryAfter } from "../http/retry.js";
import { PredictRequest } from "../types/predict.types.js";
import { stubFetch } from "./test-fetch.js";

const API_KEY = "fdk_live_SECRETVALUE";
const JWT = "eyJ.SECRETJWT.sig";

const REQUEST: PredictRequest = {
  transaction_id: "txn-0000000001",
  sender_id: "acct-123",
  receiver_id: "acct-456",
  amount: 50000,
  transaction_type: "TRANSFER",
  timestamp: 1735689600000,
};

describe("credential exposure", () => {
  const client = new OjuriClient({
    baseUrl: "https://rda.example.com",
    fiaUrl: "https://fia.example.com",
    apiKey: API_KEY,
    jwt: JWT,
  });

  it("keeps secrets out of JSON serialisation", () => {
    const serialised = JSON.stringify(client);
    expect(serialised).not.toContain(API_KEY);
    expect(serialised).not.toContain(JWT);
  });

  it("keeps secrets out of util.inspect / console.log output", () => {
    const inspected = require("node:util").inspect(client, { depth: null, showHidden: true });
    expect(inspected).not.toContain(API_KEY);
    expect(inspected).not.toContain(JWT);
  });

  it("keeps secrets out of enumerable own properties", () => {
    expect(JSON.stringify(Object.values(client))).not.toContain(API_KEY);
  });

  it("still sends the credentials it is hiding", async () => {
    const stub = stubFetch([{ body: { transaction_id: "t" } }]);
    const sending = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: API_KEY,
      fetch: stub.fetch,
    });

    await sending.predict(REQUEST);

    expect((stub.calls[0]!.init.headers as Record<string, string>)["X-Api-Key"]).toBe(API_KEY);
  });
});

describe("cancellation", () => {
  it("never sends when the signal is already aborted", async () => {
    const stub = stubFetch([{ body: {} }]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: API_KEY,
      fetch: stub.fetch,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.predict(REQUEST, { signal: controller.signal })).rejects.toBeDefined();
    expect(stub.calls).toHaveLength(0);
  });

  it("stops retrying when the caller aborts during backoff", async () => {
    const stub = stubFetch([{ status: 503, body: { status: false, message: "down" } }]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: API_KEY,
      fetch: stub.fetch,
      maxRetries: 5,
      retryBaseDelayMs: 30_000,
    });
    const controller = new AbortController();

    const pending = client.predict(REQUEST, { signal: controller.signal });
    await Promise.resolve();
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toBeDefined();
    expect(stub.calls).toHaveLength(1);
  }, 1000);
});

describe("Retry-After parsing", () => {
  it("treats a missing header as no signal", () => {
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("clamps a negative delay to zero", () => {
    expect(parseRetryAfter("-5")).toBe(0);
  });

  it("reads delay-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2);
  });

  it("reads the HTTP-date form", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30);
  });

  it("clamps an HTTP-date already in the past", () => {
    const now = Date.parse("2026-01-01T00:01:00.000Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it("ignores an unparseable value", () => {
    expect(parseRetryAfter("soon")).toBeNull();
  });

  it("retries a 409 scheduled by an HTTP-date", async () => {
    const stub = stubFetch([
      {
        status: 409,
        body: { status: false, message: "in flight" },
        headers: { "Retry-After": new Date(Date.now() - 1000).toUTCString() },
      },
      { body: { transaction_id: "t" } },
    ]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      apiKey: API_KEY,
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
    });

    await client.predict(REQUEST);

    expect(stub.calls).toHaveLength(2);
  });

  it("never lets Retry-After promote a 500", () => {
    expect(isRetryable(new OjuriApiError("boom", { status: 500, retryAfterSeconds: 1 }))).toBe(
      false
    );
  });
});

describe("path segment validation", () => {
  function client(stub = stubFetch([{ body: {} }])) {
    return {
      stub,
      sdk: new OjuriClient({
        baseUrl: "https://rda.example.com",
        fiaUrl: "https://fia.example.com",
        jwt: JWT,
        fetch: stub.fetch,
      }),
    };
  }

  it.each([[".."], ["."], ["..."], [""]])("rejects the id %p before sending", async (id) => {
    const { sdk, stub } = client();

    await expect(sdk.decisions.get(id)).rejects.toBeInstanceOf(OjuriValidationError);
    await expect(sdk.decisions.similar(id)).rejects.toBeInstanceOf(OjuriValidationError);
    await expect(sdk.decisions.override(id, { decision: "ACCEPT" })).rejects.toBeInstanceOf(
      OjuriValidationError
    );
    await expect(sdk.reports.get(id)).rejects.toBeInstanceOf(OjuriValidationError);
    await expect(sdk.reports.message(id, "hi")).rejects.toBeInstanceOf(OjuriValidationError);
    expect(stub.calls).toHaveLength(0);
  });

  it("keeps a slashed id inside its own segment", async () => {
    const { sdk, stub } = client(stubFetch([{ body: { status: true, data: {} } }]));

    await sdk.decisions.get("a/../../b");

    expect(stub.calls[0]!.url).toBe("https://rda.example.com/v1/decisions/a%2F..%2F..%2Fb");
  });
});

describe("transaction_id validation", () => {
  it.each([["short"], [""], ["x".repeat(256)]])(
    "rejects %p before sending",
    async (transactionId) => {
      const stub = stubFetch([{ body: {} }]);
      const client = new OjuriClient({
        baseUrl: "https://rda.example.com",
        apiKey: API_KEY,
        fetch: stub.fetch,
      });

      await expect(
        client.predict({ ...REQUEST, transaction_id: transactionId })
      ).rejects.toBeInstanceOf(OjuriValidationError);
      expect(stub.calls).toHaveLength(0);
    }
  );
});
