import { FetchLike } from "./http/transport.types.js";

export interface OjuriClientOptions {
  /** RDA base URL, e.g. https://rda.example.com */
  baseUrl: string;
  /** FIA base URL, e.g. https://fia.example.com — required only for `reports`. */
  fiaUrl?: string;
  apiKey?: string;
  jwt?: string;
  tenantId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Attach a generated Idempotency-Key to every predict call. Default true. */
  autoIdempotencyKey?: boolean;
  fetch?: FetchLike;
  userAgent?: string;
}

export interface RequestOptions {
  correlationId?: string;
  tenantId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PredictOptions extends RequestOptions {
  idempotencyKey?: string;
}
