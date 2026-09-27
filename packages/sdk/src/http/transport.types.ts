export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type QueryValue = string | number | boolean | undefined;

export interface TransportConfig {
  baseUrl: string;
  timeoutMs: number;
  deadlineMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  fetch: FetchLike;
  userAgent: string;
}

export interface RequestSpec {
  method: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Defaults to true for GET only — a replayed write can duplicate effects. */
  retryable?: boolean;
}

export interface TransportResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}
