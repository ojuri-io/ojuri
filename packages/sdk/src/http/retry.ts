import OjuriApiError from "../errors/api.error.js";
import OjuriNetworkError from "../errors/network.error.js";
import OjuriTimeoutError from "../errors/timeout.error.js";

const MAX_BACKOFF_MS = 20_000;
const MAX_RETRY_AFTER_SECONDS = 86_400;

const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof OjuriTimeoutError || err instanceof OjuriNetworkError) return true;
  if (!(err instanceof OjuriApiError)) return false;
  // Retry-After promotes a 4xx the server is explicitly rescheduling (RDA marks
  // an in-flight Idempotency-Key that way). It must not promote a 500: the
  // server ran the request and failed inside it, so a retry can duplicate
  // effects the client cannot see.
  if (err.retryAfterSeconds !== null && err.status < 500) return true;
  return RETRYABLE_STATUSES.has(err.status);
}

export function parseRetryAfter(raw: string | null, now: number = Date.now()): number | null {
  // A missing header must stay null: `Number(null)` is 0, and a 0 here would
  // mark every 4xx as server-scheduled and therefore retryable.
  if (raw === null) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return clamp(seconds);

  // RFC 9110 also allows an HTTP-date, which a proxy in front of RDA may emit.
  const deadline = Date.parse(raw);
  if (Number.isNaN(deadline)) return null;
  return clamp((deadline - now) / 1000);
}

// The value is surfaced on OjuriApiError, so keep it sane for callers that
// schedule their own retry from it rather than relying on ours.
function clamp(seconds: number): number {
  return Math.min(Math.max(0, seconds), MAX_RETRY_AFTER_SECONDS);
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

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();

    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
