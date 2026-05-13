/**
 * Token-bucket rate limiter keyed by API-key id. In-memory only —
 * sufficient for a single RDA replica; for horizontal scale, swap
 * the store for a Redis-backed counter behind the same interface.
 */
interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export function checkRate(keyId: string, ratePerMinute: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(keyId);

  const capacity = Math.max(ratePerMinute, 1);
  const refillPerMs = capacity / 60_000;

  if (!bucket || bucket.capacity !== capacity) {
    bucket = { tokens: capacity, capacity, refillPerMs, lastRefill: now };
    buckets.set(keyId, bucket);
  } else {
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}
