import { FetchLike } from "./http/transport.types.js";

export interface OjuriClientOptions {
  /** RDA base URL, e.g. https://rda.example.com */
  baseUrl: string;
  apiKey?: string;
  tenantId?: string;
  timeoutMs?: number;
  /** Total wall-clock budget per call including retries. Defaults to `timeoutMs * (maxRetries + 1)`. */
  deadlineMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Generate an Idempotency-Key when the caller does not supply one. Defaults to false. */
  autoIdempotencyKey?: boolean;
  fetch?: FetchLike;
  userAgent?: string;
}

export interface PredictOptions {
  idempotencyKey?: string;
  correlationId?: string;
  tenantId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
