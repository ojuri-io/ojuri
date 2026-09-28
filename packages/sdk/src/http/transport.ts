import OjuriApiError from "../errors/api.error.js";
import OjuriNetworkError from "../errors/network.error.js";
import OjuriResponseError from "../errors/response.error.js";
import OjuriTimeoutError from "../errors/timeout.error.js";
import OjuriValidationError from "../errors/validation.error.js";
import {
  backoffDelayMs,
  isRetryable,
  parseRetryAfter,
  retryAfterSecondsOf,
  sleep,
} from "./retry.js";
import { QueryValue, RequestSpec, TransportConfig, TransportResponse } from "./transport.types.js";

const MAX_RETAINED_BODY_CHARS = 8192;

class Transport {
  constructor(private readonly config: TransportConfig) {}

  async request<T>(spec: RequestSpec): Promise<TransportResponse<T>> {
    const url = this.buildUrl(spec.path, spec.query);
    const payload = spec.body === undefined ? undefined : serializeBody(spec.body);
    const deadline = Date.now() + this.config.deadlineMs;
    const retryable = spec.retryable ?? spec.method === "GET";

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt<T>(spec, url, payload, deadline);
      } catch (err) {
        if (!retryable || attempt >= this.config.maxRetries || !isRetryable(err)) throw err;
        const delay = backoffDelayMs(
          attempt,
          this.config.retryBaseDelayMs,
          retryAfterSecondsOf(err)
        );
        if (Date.now() + delay >= deadline) throw err;
        await sleep(delay, spec.signal);
      }
    }
  }

  private async attempt<T>(
    spec: RequestSpec,
    url: string,
    payload: string | undefined,
    deadline: number
  ): Promise<TransportResponse<T>> {
    // A signal that fired before this attempt was scheduled never emits an
    // "abort" event, so the listener below would miss it entirely.
    if (spec.signal?.aborted) throw toAbortError(spec.signal.reason);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new OjuriTimeoutError(this.config.deadlineMs);
    const timeoutMs = Math.min(spec.timeoutMs ?? this.config.timeoutMs, remaining);

    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortOnCallerSignal = () => controller.abort();
    spec.signal?.addEventListener("abort", abortOnCallerSignal, { once: true });

    try {
      const response = await this.config.fetch(url, {
        method: spec.method,
        headers: this.buildHeaders(spec, payload),
        body: payload,
        signal: controller.signal,
      });

      const { value, json } = await parseBody(response);
      if (!response.ok) throw toApiError(response, value);

      // A captive portal or WAF challenge answers 200 with HTML. Resolving on
      // that would hand the caller a string where a decision belongs.
      if (!json) {
        throw new OjuriResponseError(
          `Expected a JSON response from ${spec.method} ${spec.path}`,
          response.status,
          value
        );
      }

      return { data: value as T, status: response.status, headers: response.headers };
    } catch (err) {
      if (err instanceof OjuriApiError || err instanceof OjuriResponseError) throw err;
      if (timedOut) throw new OjuriTimeoutError(timeoutMs);
      if (spec.signal?.aborted) throw toAbortError(spec.signal.reason);
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

  private buildHeaders(spec: RequestSpec, payload: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.config.userAgent,
      ...spec.headers,
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    return headers;
  }
}

function serializeBody(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch (err) {
    throw new OjuriValidationError("body", `Request body is not JSON-serialisable: ${describe(err)}`);
  }
}

async function parseBody(response: Response): Promise<{ value: unknown; json: boolean }> {
  const text = await response.text();
  if (text.length === 0) return { value: null, json: true };
  try {
    return { value: JSON.parse(text), json: true };
  } catch {
    return { value: text, json: false };
  }
}

function toAbortError(reason: unknown): unknown {
  if (reason instanceof Error) return reason;
  const message = reason === undefined ? "This operation was aborted" : String(reason);
  return new DOMException(message, "AbortError");
}

function toApiError(response: Response, body: unknown): OjuriApiError {
  return new OjuriApiError(messageFrom(body, response), {
    status: response.status,
    code: codeFrom(body),
    errors: errorsFrom(body),
    correlationId: response.headers.get("X-Correlation-ID"),
    retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
    body: truncate(body),
  });
}

// Adopters attach these to Sentry; an outage should not pin megabytes per error.
function truncate(body: unknown): unknown {
  if (typeof body === "string") {
    return body.length > MAX_RETAINED_BODY_CHARS
      ? `${body.slice(0, MAX_RETAINED_BODY_CHARS)}…`
      : body;
  }
  const serialized = safeStringify(body);
  if (serialized === null || serialized.length <= MAX_RETAINED_BODY_CHARS) return body;
  return `${serialized.slice(0, MAX_RETAINED_BODY_CHARS)}…`;
}

function safeStringify(body: unknown): string | null {
  try {
    return JSON.stringify(body) ?? null;
  } catch {
    return null;
  }
}

// RDA wraps failures as `{ status: false, message, errors }`; FIA answers
// with `{ error }`. Both reach adopters through this SDK.
function messageFrom(body: unknown, response: Response): string {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  if (typeof body === "string" && body.length > 0) return body.slice(0, 200);
  return `HTTP ${response.status} ${response.statusText}`.trim();
}

function codeFrom(body: unknown): string | null {
  if (typeof body === "object" && body !== null) {
    const { code } = body as Record<string, unknown>;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
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
