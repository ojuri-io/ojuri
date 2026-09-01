import OjuriApiError from "../errors/api.error.js";
import OjuriNetworkError from "../errors/network.error.js";
import OjuriTimeoutError from "../errors/timeout.error.js";

const MAX_BACKOFF_MS = 20_000;

// 500 is deliberately absent: the server handled the request and failed
// inside it, so a blind retry can duplicate side effects the client can't
// observe. Everything here is either pre-handler or explicitly transient.
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof OjuriTimeoutError || err instanceof OjuriNetworkError) return true;
  if (err instanceof OjuriApiError) {
    return RETRYABLE_STATUSES.has(err.status) || err.retryAfterSeconds !== null;
  }
  return false;
}

export function retryAfterSecondsOf(err: unknown): number | null {
  return err instanceof OjuriApiError ? err.retryAfterSeconds : null;
}

export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  retryAfterSeconds: number | null,
  random: () => number = Math.random
): number {
  if (retryAfterSeconds !== null) return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  const ceiling = Math.min(baseDelayMs * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(random() * ceiling);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
