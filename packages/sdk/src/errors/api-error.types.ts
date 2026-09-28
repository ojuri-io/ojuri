export interface ApiErrorDetails {
  status: number;
  /** Server-supplied machine-readable cause; absent on responses that carry none. */
  code?: string | null;
  errors?: unknown[];
  correlationId?: string | null;
  retryAfterSeconds?: number | null;
  body?: unknown;
}
