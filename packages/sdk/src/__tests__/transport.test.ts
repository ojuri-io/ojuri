import OjuriClient from "../client.js";
import OjuriApiError from "../errors/api.error.js";
import OjuriConfigurationError from "../errors/configuration.error.js";
import OjuriNetworkError from "../errors/network.error.js";
import { backoffDelayMs, isRetryable } from "../http/retry.js";
import OjuriTimeoutError from "../errors/timeout.error.js";
import { stubFetch } from "./test-fetch.js";

describe("transport", () => {
  it("stops retrying after maxRetries and throws the last error", async () => {
    const stub = stubFetch([{ status: 503, body: { status: false, message: "down" } }]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      jwt: "jwt-token",
      fetch: stub.fetch,
      maxRetries: 3,
      retryBaseDelayMs: 0,
    });

    await expect(client.decisions.recent()).rejects.toBeInstanceOf(OjuriApiError);
    expect(stub.calls).toHaveLength(4);
  });

  it("wraps a fetch rejection as a network error and retries it", async () => {
    const stub = stubFetch([new Error("ECONNREFUSED"), { body: { status: true, data: [] } }]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      jwt: "jwt-token",
      fetch: stub.fetch,
      retryBaseDelayMs: 0,
    });

    await expect(client.decisions.recent()).resolves.toEqual([]);
    expect(stub.calls).toHaveLength(2);
  });

  it("reports a timeout as OjuriTimeoutError", async () => {
    const fetch = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      jwt: "jwt-token",
      fetch,
      timeoutMs: 5,
      maxRetries: 0,
    });

    await expect(client.decisions.recent()).rejects.toBeInstanceOf(OjuriTimeoutError);
  });

  it("honours a caller AbortSignal without disguising it", async () => {
    const controller = new AbortController();
    const fetch = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com",
      jwt: "jwt-token",
      fetch,
      maxRetries: 0,
    });

    const pending = client.decisions.recent({}, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.not.toBeInstanceOf(OjuriNetworkError);
  });

  it("builds query strings and unwraps the success envelope", async () => {
    const stub = stubFetch([
      { body: { status: true, message: "Review queue", data: { rows: [], total: 0 } } },
    ]);
    const client = new OjuriClient({
      baseUrl: "https://rda.example.com/",
      jwt: "jwt-token",
      fetch: stub.fetch,
    });

    const page = await client.decisions.reviewQueue({ limit: 10, order: "oldest" });

    expect(page).toEqual({ rows: [], total: 0 });
    expect(stub.calls[0]!.url).toBe("https://rda.example.com/v1/review-queue?limit=10&order=oldest");
  });

  it("requires a JWT for audit reads", async () => {
    const stub = stubFetch([{ body: {} }]);
    const client = new OjuriClient({ baseUrl: "https://rda.example.com", fetch: stub.fetch });

    await expect(client.decisions.recent()).rejects.toBeInstanceOf(OjuriConfigurationError);
  });

  it("stores the JWT returned by login", async () => {
    const stub = stubFetch([
      { body: { status: true, data: { token: "fresh-jwt", expiresAt: "2026-01-01T00:00:00.000Z" } } },
      { body: { status: true, data: [] } },
    ]);
    const client = new OjuriClient({ baseUrl: "https://rda.example.com", fetch: stub.fetch });

    await client.login({ username: "admin", password: "secret" });
    await client.decisions.recent();

    expect((stub.calls[1]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer fresh-jwt"
    );
  });

  it("raises a configuration error when reports are used without fiaUrl", () => {
    const client = new OjuriClient({ baseUrl: "https://rda.example.com", jwt: "j" });

    expect(() => client.reports).toThrow(OjuriConfigurationError);
  });
});

describe("retry policy", () => {
  it.each([408, 429, 502, 503, 504])("retries %i", (status) => {
    expect(isRetryable(new OjuriApiError("x", { status }))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422, 500])("does not retry %i", (status) => {
    expect(isRetryable(new OjuriApiError("x", { status }))).toBe(false);
  });

  it("retries any status that carries Retry-After", () => {
    expect(isRetryable(new OjuriApiError("x", { status: 409, retryAfterSeconds: 1 }))).toBe(true);
  });

  it("prefers Retry-After over jittered backoff", () => {
    expect(backoffDelayMs(0, 200, 2)).toBe(2000);
  });

  it("caps jittered backoff at the doubling ceiling", () => {
    expect(backoffDelayMs(3, 100, null, () => 1)).toBe(800);
    expect(backoffDelayMs(3, 100, null, () => 0)).toBe(0);
  });
});
