import OjuriApiError from "../errors/api.error.js";
import OjuriNetworkError from "../errors/network.error.js";
import OjuriTimeoutError from "../errors/timeout.error.js";
import { backoffDelayMs, isRetryable, retryAfterSecondsOf, sleep } from "./retry.js";
import { QueryValue, RequestSpec, TransportConfig, TransportResponse } from "./transport.types.js";

class Transport {
  constructor(private readonly config: TransportConfig) {}

  async request<T>(spec: RequestSpec): Promise<TransportResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt<T>(spec);
      } catch (err) {
        if (attempt >= this.config.maxRetries || !isRetryable(err)) throw err;
        await sleep(
          backoffDelayMs(attempt, this.config.retryBaseDelayMs, retryAfterSecondsOf(err))
        );
      }
    }
  }

  private async attempt<T>(spec: RequestSpec): Promise<TransportResponse<T>> {
    const timeoutMs = spec.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortOnCallerSignal = () => controller.abort();
    spec.signal?.addEventListener("abort", abortOnCallerSignal, { once: true });

    try {
      const response = await this.config.fetch(this.buildUrl(spec.path, spec.query), {
        method: spec.method,
        headers: this.buildHeaders(spec),
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
      });

      const data = await parseBody(response);
      if (!response.ok) throw toApiError(response, data);

      return { data: data as T, status: response.status, headers: response.headers };
    } catch (err) {
      if (err instanceof OjuriApiError) throw err;
      if (timedOut) throw new OjuriTimeoutError(timeoutMs);
      if (spec.signal?.aborted) throw err;
      throw new OjuriNetworkError(
        `Request to ${spec.method} ${spec.path} failed: ${describe(err)}`,
        err
      );
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", abortOnCallerSignal);
    }
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(path.replace(/^\//, ""), `${this.config.baseUrl.replace(/\/$/, "")}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private buildHeaders(spec: RequestSpec): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.config.userAgent,
      ...spec.headers,
    };
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    return headers;
  }
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(response: Response, body: unknown): OjuriApiError {
  return new OjuriApiError(messageFrom(body, response), {
    status: response.status,
    errors: errorsFrom(body),
    correlationId: response.headers.get("X-Correlation-ID"),
    retryAfterSeconds: retryAfterOf(response),
    body,
  });
}

// A missing header must stay null: `Number(null)` is 0, and a 0 here would
// mark every 4xx as server-scheduled and therefore retryable.
function retryAfterOf(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

// RDA wraps failures as `{ status: false, message, errors }`; FIA answers
// with `{ error }`. Both reach adopters through this SDK.
function messageFrom(body: unknown, response: Response): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  if (typeof body === "string" && body.length > 0) return body;
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

function errorsFrom(body: unknown): unknown[] {
  if (typeof body === "object" && body !== null) {
    const { errors } = body as Record<string, unknown>;
    if (Array.isArray(errors)) return errors;
  }
  return [];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Transport;
