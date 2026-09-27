export interface ApiErrorDetails {
  status: number;
  errors?: unknown[];
  correlationId?: string | null;
  retryAfterSeconds?: number | null;
  body?: unknown;
}
