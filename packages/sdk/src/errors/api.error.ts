import OjuriError from "./ojuri.error.js";
import { ApiErrorDetails } from "./api-error.types.js";

class OjuriApiError extends OjuriError {
  public readonly status: number;
  /**
   * Branch on this rather than on `message`. Two conditions return 409 and mean
   * opposite things, and the text is for a human reading a log.
   */
  public readonly code: string | null;
  public readonly errors: unknown[];
  public readonly correlationId: string | null;
  public readonly retryAfterSeconds: number | null;
  public readonly body: unknown;

  constructor(message: string, details: ApiErrorDetails) {
    super(message);
    this.status = details.status;
    this.code = details.code ?? null;
    this.errors = details.errors ?? [];
    this.correlationId = details.correlationId ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.body = details.body ?? null;
  }

  static isOjuriApiError(err: unknown): err is OjuriApiError {
    return OjuriError.isOjuriError(err) && err.name === "OjuriApiError";
  }
}

export default OjuriApiError;
