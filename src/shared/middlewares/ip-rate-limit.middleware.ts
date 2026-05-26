import { FastifyReply, FastifyRequest } from "fastify";
import httpStatus from "http-status";
import { ErrorResponse } from "@shared/utils/response.util";

/**
 * In-memory per-IP token bucket. Sufficient for a single RDA replica
 * and the typical "stop a credential-stuffing script" use case. For
 * horizontal scale, swap the store for Redis with the same interface.
 *
 * Buckets self-prune when they go a full window without traffic, so
 * the map can't grow unbounded on the back of random IPs.
 */
interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

function checkRate(key: string, ratePerMinute: number): boolean {
  const now = Date.now();
  const capacity = Math.max(ratePerMinute, 1);
  const refillPerMs = capacity / 60_000;

  let bucket = buckets.get(key);
  if (!bucket || bucket.capacity !== capacity) {
    bucket = { tokens: capacity, capacity, refillPerMs, lastRefill: now };
    buckets.set(key, bucket);
  } else {
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// Cheap periodic prune so a transient burst of distinct IPs doesn't
// leave entries in the map forever. Buckets idle for >10 min get evicted.
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const EVICT_AFTER_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - EVICT_AFTER_MS;
  for (const [key, b] of buckets) {
    if (b.lastRefill < cutoff) buckets.delete(key);
  }
}, PRUNE_INTERVAL_MS).unref();

/**
 * Build a Fastify preHandler that throttles requests per source IP.
 * Defaults to 20 / minute; override via `ratePerMinute` or the
 * `IP_RATE_LIMIT_PER_MINUTE` env var on a per-route basis. Returns 429
 * with a small JSON body when the bucket is empty.
 */
export function ipRateLimit(
  options: { ratePerMinute?: number; envKey?: string; routeLabel?: string } = {}
) {
  const fromEnv = options.envKey ? Number(process.env[options.envKey]) : NaN;
  const rate = Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : options.ratePerMinute ?? 20;

  return async (req: FastifyRequest, res: FastifyReply) => {
    const ip = clientIp(req);
    const key = options.routeLabel ? `${options.routeLabel}:${ip}` : ip;
    if (!checkRate(key, rate)) {
      return res
        .code(httpStatus.TOO_MANY_REQUESTS)
        .header("Retry-After", "60")
        .send(ErrorResponse("Too many requests, slow down"));
    }
  };
}

/**
 * Best-effort client IP. Prefers the first hop in X-Forwarded-For when
 * Fastify is behind a trusted proxy (default in the shipped NGINX
 * config), otherwise falls back to the socket address.
 */
function clientIp(req: FastifyRequest): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}
