import Credentials from "./credentials.js";
import OjuriConfigurationError from "./errors/configuration.error.js";
import Transport from "./http/transport.js";
import PredictResource from "./resources/predict.resource.js";
import { OjuriClientOptions, PredictOptions } from "./client.types.js";
import { FetchLike } from "./http/transport.types.js";
import { PredictRequest, PredictResult } from "./types/predict.types.js";
import { SDK_VERSION } from "./version.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;

class OjuriClient {
  readonly #credentials: Credentials;
  readonly #predictions: PredictResource;

  constructor(options: OjuriClientOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    this.#credentials = new Credentials(options.apiKey ?? null, options.tenantId ?? null);
    this.#predictions = new PredictResource(
      new Transport({
        baseUrl: assertHttpUrl("baseUrl", options.baseUrl),
        timeoutMs,
        maxRetries,
        deadlineMs: options.deadlineMs ?? timeoutMs * (maxRetries + 1),
        retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
        fetch: resolveFetch(options.fetch),
        userAgent: options.userAgent ?? `ojuri-sdk/${SDK_VERSION} node/${process.versions.node}`,
      }),
      this.#credentials,
      options.autoIdempotencyKey ?? false
    );
  }

  predict(request: PredictRequest, options: PredictOptions = {}): Promise<PredictResult> {
    return this.#predictions.create(request, options);
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
