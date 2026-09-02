import Credentials from "./credentials.js";
import OjuriConfigurationError from "./errors/configuration.error.js";
import Transport from "./http/transport.js";
import AuthResource from "./resources/auth.resource.js";
import DecisionsResource from "./resources/decisions.resource.js";
import PredictResource from "./resources/predict.resource.js";
import ReportsResource from "./resources/reports.resource.js";
import { OjuriClientOptions, PredictOptions, RequestOptions } from "./client.types.js";
import { FetchLike } from "./http/transport.types.js";
import { LoginInput, LoginResult } from "./types/auth.types.js";
import { PredictRequest, PredictResult } from "./types/predict.types.js";
import { SDK_VERSION } from "./version.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
// Report generation runs an LLM; one retry, not the client default.
const LLM_TIMEOUT_MS = 180_000;
const LLM_MAX_RETRIES = 1;

class OjuriClient {
  public readonly auth: AuthResource;
  public readonly decisions: DecisionsResource;
  /** Present only when `fiaUrl` is configured. */
  public readonly reports?: ReportsResource;

  readonly #credentials: Credentials;
  readonly #predictions: PredictResource;

  constructor(options: OjuriClientOptions) {
    const baseUrl = assertHttpUrl("baseUrl", options.baseUrl);
    const fetchImpl = resolveFetch(options.fetch);
    const userAgent = options.userAgent ?? `ojuri-sdk/${SDK_VERSION} node/${process.versions.node}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const shared = {
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      fetch: fetchImpl,
      userAgent,
    };

    this.#credentials = new Credentials(
      options.apiKey ?? null,
      options.jwt ?? null,
      options.tenantId ?? null
    );

    const rda = new Transport({
      baseUrl,
      timeoutMs,
      maxRetries,
      deadlineMs: options.deadlineMs ?? timeoutMs * (maxRetries + 1),
      ...shared,
    });
    this.auth = new AuthResource(rda);
    this.decisions = new DecisionsResource(rda, this.#credentials);
    this.#predictions = new PredictResource(
      rda,
      this.#credentials,
      options.autoIdempotencyKey ?? true
    );

    if (options.fiaUrl) {
      const llmTimeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;
      const llmMaxRetries = options.maxRetries ?? LLM_MAX_RETRIES;
      this.reports = new ReportsResource(
        new Transport({
          baseUrl: assertHttpUrl("fiaUrl", options.fiaUrl),
          timeoutMs: llmTimeoutMs,
          maxRetries: llmMaxRetries,
          deadlineMs: options.deadlineMs ?? llmTimeoutMs * (llmMaxRetries + 1),
          ...shared,
        }),
        this.#credentials
      );
    }
  }

  predict(request: PredictRequest, options: PredictOptions = {}): Promise<PredictResult> {
    return this.#predictions.create(request, options);
  }

  async login(input: LoginInput, options: RequestOptions = {}): Promise<LoginResult> {
    const ticket = this.#credentials.beginLogin();
    const result = await this.auth.login(input, options);
    this.#credentials.completeLogin(ticket, result.token);
    return result;
  }

  setJwt(jwt: string | null): void {
    this.#credentials.setJwt(jwt);
  }

  setApiKey(apiKey: string | null): void {
    this.#credentials.setApiKey(apiKey);
  }
}

function assertHttpUrl(field: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OjuriConfigurationError(`\`${field}\` must be an absolute URL, received "${value}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OjuriConfigurationError(`\`${field}\` must be http or https, received "${value}".`);
  }
  return value;
}

function resolveFetch(override?: FetchLike): FetchLike {
  if (override) return override;
  if (typeof globalThis.fetch !== "function") {
    throw new OjuriConfigurationError(
      "No global fetch found. Use Node 18+ or pass a `fetch` implementation."
    );
  }
  return globalThis.fetch.bind(globalThis);
}

export default OjuriClient;
