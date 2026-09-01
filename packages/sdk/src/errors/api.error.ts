import OjuriError from "./ojuri.error.js";
import { ApiErrorDetails } from "./api-error.types.js";

class OjuriApiError extends OjuriError {
  public readonly status: number;
  public readonly errors: unknown[];
  public readonly correlationId: string | null;
  public readonly retryAfterSeconds: number | null;
  public readonly body: unknown;

  constructor(message: string, details: ApiErrorDetails) {
    super(message);
    this.status = details.status;
    this.errors = details.errors ?? [];
    this.correlationId = details.correlationId ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.body = details.body ?? null;
  }
}

export default OjuriApiError;
