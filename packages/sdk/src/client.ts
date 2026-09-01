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

class OjuriClient {
  public readonly auth: AuthResource;
  public readonly decisions: DecisionsResource;

  private readonly credentials: Credentials;
  private readonly predictions: PredictResource;
  private readonly reportsResource: ReportsResource | null;

  constructor(options: OjuriClientOptions) {
    if (!options.baseUrl) {
      throw new OjuriConfigurationError("`baseUrl` is required (your RDA origin).");
    }

    const fetchImpl = resolveFetch(options.fetch);
    const userAgent = options.userAgent ?? `ojuri-sdk/${SDK_VERSION} node/${process.versions.node}`;
    const shared = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      fetch: fetchImpl,
      userAgent,
    };

    this.credentials = new Credentials(
      options.apiKey ?? null,
      options.jwt ?? null,
      options.tenantId ?? null
    );

    const rda = new Transport({ baseUrl: options.baseUrl, ...shared });
    this.auth = new AuthResource(rda);
    this.decisions = new DecisionsResource(rda, this.credentials);
    this.predictions = new PredictResource(
      rda,
      this.credentials,
      options.autoIdempotencyKey ?? true
    );

    this.reportsResource = options.fiaUrl
      ? new ReportsResource(
          new Transport({ baseUrl: options.fiaUrl, ...shared }),
          this.credentials
        )
      : null;
  }

  predict(request: PredictRequest, options: PredictOptions = {}): Promise<PredictResult> {
    return this.predictions.create(request, options);
  }

  async login(input: LoginInput, options: RequestOptions = {}): Promise<LoginResult> {
    const result = await this.auth.login(input, options);
    this.credentials.setJwt(result.token);
    return result;
  }

  setJwt(jwt: string | null): void {
    this.credentials.setJwt(jwt);
  }

  setApiKey(apiKey: string | null): void {
    this.credentials.setApiKey(apiKey);
  }

  get reports(): ReportsResource {
    if (!this.reportsResource) {
      throw new OjuriConfigurationError("`fiaUrl` is required to use investigation reports.");
    }
    return this.reportsResource;
  }
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
