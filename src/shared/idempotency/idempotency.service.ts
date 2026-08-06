import { createHash, randomUUID } from "crypto";
import { gunzipSync, gzipSync } from "zlib";
import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import RedisClient from "@shared/redis-client/redis-client";

const log = createServiceLogger("IdempotencyService");

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const LOCK_TTL_SECONDS = 15;
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_POLL_TIMEOUT_MS = 3_000;

const COMPRESS = (process.env.IDEMPOTENCY_COMPRESS ?? "false").toLowerCase() === "true";
const MAX_KEYS_PER_TENANT =
  Number(process.env.IDEMPOTENCY_MAX_KEYS_PER_TENANT) || 10_000;
const COMPRESS_PREFIX = "gz:";

export type IdempotencyOutcome =
  | { kind: "miss" }
  | { kind: "replay"; response: Record<string, unknown> }
  | { kind: "conflict" }
  | { kind: "in_flight" };

interface IdempotencyInput {
  tenantId: string;
  apiKeyId: string | null;
  key: string;
}

interface StoredEntry {
  requestHash: string;
  response: Record<string, unknown>;
}

interface AcquiredLock {
  release(): Promise<void>;
}

/**
 * Redis-backed idempotency cache for `POST /v1/predict`. Sub-ms
 * operations vs the 1–10 ms round-trips a Postgres cache would cost.
 *
 * Composite key includes the API key ID so two unrelated callers of
 * the same tenant who happen to share an Idempotency-Key value get
 * isolation — without it, callerA's response would leak to callerB
 * on the first replay.
 *
 * Bloat controls (all configurable via env):
 *   - Per-entry TTL (`IDEMPOTENCY_TTL_MS`, default 24 h) — Redis-native.
 *   - Optional gzip (`IDEMPOTENCY_COMPRESS=true`) — ~60 % smaller on
 *     typical PredictResponseDto payloads, sub-ms CPU cost.
 *   - Per-tenant cardinality cap (`IDEMPOTENCY_MAX_KEYS_PER_TENANT`,
 *     default 10 000) — prevents a single noisy tenant filling the
 *     cache for everyone. Tracked via a per-tenant sorted set; the
 *     oldest entries are evicted lazily on each store.
 */
@singleton()
class IdempotencyService {
  constructor(private readonly redis: RedisClient) {}

  async lookup(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyOutcome> {
    const raw = await this.redis.get().get(respKey(input));
    if (!raw) {
      metricsService.recordIdempotencyLookup("miss");
      return { kind: "miss" };
    }

    const entry = decodeEntry(raw);
    if (!entry) {
      log.warn("lookup", "Stored entry could not be decoded; treating as miss");
      metricsService.recordIdempotencyLookup("miss");
      return { kind: "miss" };
    }
    if (entry.requestHash !== input.requestHash) {
      metricsService.recordIdempotencyLookup("conflict");
      return { kind: "conflict" };
    }
    metricsService.recordIdempotencyLookup("hit");
    return { kind: "replay", response: entry.response };
  }

  async store(input: IdempotencyInput & {
    requestHash: string;
    response: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<void> {
    const ttlSec = Math.max(1, Math.floor((input.ttlMs ?? IDEMPOTENCY_TTL_MS) / 1000));
    const entry: StoredEntry = { requestHash: input.requestHash, response: input.response };
    const stored = encodeEntry(entry);
    const composite = composeKey(input);
    const key = respKey(input);
    const tenantSet = tenantSetKey(input.tenantId);

    try {
      const client = this.redis.get();
      const expiresAtMs = Date.now() + ttlSec * 1000;
      await client
        .multi()
        .set(key, stored, "EX", ttlSec)
        // Score = expiry, member = composite. The tenant set has its
        // own TTL refreshed each write so it eventually disappears
        // for tenants that go quiet.
        .zadd(tenantSet, expiresAtMs, composite)
        .expire(tenantSet, ttlSec + 60)
        .exec();
      metricsService.recordIdempotencyStore(stored.startsWith(COMPRESS_PREFIX));
    } catch (err) {
      log.error("store", "Failed to persist idempotency record", { err: String(err) });
      return;
    }

    // Enforce per-tenant cardinality cap. Best-effort: under concurrent
    // writes a tenant may briefly exceed the cap, then settle on the
    // next call. Doesn't block the predict path — failure here is logged
    // and ignored.
    await this.enforceTenantCap(input.tenantId).catch((err) =>
      log.warn("store", "Tenant cap enforcement failed", { tenantId: input.tenantId, err: String(err) })
    );
  }

  /**
   * SETNX lock so only one concurrent request for a given key tuple
   * runs the expensive ML path. The TTL guards against a leader crash
   * leaving the lock dangling.
   */
  async acquireLock(input: IdempotencyInput): Promise<AcquiredLock | null> {
    const client = this.redis.get();
    const key = lockKey(input);
    const value = randomUUID();
    const acquired = await client.set(key, value, "EX", LOCK_TTL_SECONDS, "NX");
    if (acquired !== "OK") return null;

    return {
      release: async () => {
        // CAS release — only delete the lock if we still own it.
        const script = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        try {
          await client.eval(script, 1, key, value);
        } catch (err) {
          log.warn("acquireLock", "release script failed (lock will expire on TTL)", {
            err: String(err),
          });
        }
      },
    };
  }

  async waitForReplay(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyOutcome> {
    const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_INTERVAL_MS);
      const outcome = await this.lookup(input);
      if (outcome.kind === "replay" || outcome.kind === "conflict") return outcome;
    }
    metricsService.recordIdempotencyLookup("in_flight");
    return { kind: "in_flight" };
  }

  static hashRequest(body: unknown): string {
    return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
  }

  // Lightweight per-(tenant, transaction_id) dedup. Used when no
  // Idempotency-Key header is set. Returns true if this is the first
  // sighting (caller should proceed), false if a previous predict
  // already reserved it (caller returns 409). TTL matches the
  // idempotency response cache so a transaction_id can't be replayed
  // for the same window.
  async reserveTransactionId(tenantId: string, transactionId: string): Promise<boolean> {
    const ttlSec = Math.max(60, Math.floor(IDEMPOTENCY_TTL_MS / 1000));
    const set = await this.redis.get().set(txnKey(tenantId, transactionId), "1", "EX", ttlSec, "NX");
    return set === "OK";
  }

  /**
   * Drop a reservation whose prediction failed. Without this a 5xx keeps
   * the transaction_id claimed for the full TTL, so the client's retry
   * gets 409 with no cached response to replay.
   */
  async releaseTransactionId(tenantId: string, transactionId: string): Promise<void> {
    try {
      await this.redis.get().del(txnKey(tenantId, transactionId));
    } catch (err) {
      log.warn("releaseTransactionId", "Failed to release reservation; it will expire on TTL", {
        transactionId,
        err: String(err),
      });
    }
  }

  private async enforceTenantCap(tenantId: string): Promise<void> {
    const client = this.redis.get();
    const tenantSet = tenantSetKey(tenantId);

    // Drop tombstones that have already expired in Redis-land but
    // still occupy slots in this tracking set.
    await client.zremrangebyscore(tenantSet, 0, Date.now() - 1);

    const size = await client.zcard(tenantSet);
    const overage = size - MAX_KEYS_PER_TENANT;
    if (overage <= 0) return;

    // Pull the oldest N composites and delete both their response
    // entries and their tracking-set membership.
    const oldest = await client.zrange(tenantSet, 0, overage - 1);
    if (oldest.length === 0) return;
    const respKeys = oldest.map((c) => `ojuri:idem:resp:${tenantId}:${c}`);
    await client.multi().del(...respKeys).zrem(tenantSet, ...oldest).exec();

    metricsService.recordIdempotencyEviction(oldest.length);
    log.info("enforceTenantCap", "Evicted oldest idempotency entries", {
      tenantId,
      evicted: oldest.length,
      cap: MAX_KEYS_PER_TENANT,
    });
  }
}

function composeKey(input: IdempotencyInput): string {
  return `${input.apiKeyId ?? "anon"}|${input.key}`;
}

function respKey(input: IdempotencyInput): string {
  return `ojuri:idem:resp:${input.tenantId}:${composeKey(input)}`;
}

function lockKey(input: IdempotencyInput): string {
  return `ojuri:idem:lock:${input.tenantId}:${composeKey(input)}`;
}

function tenantSetKey(tenantId: string): string {
  return `ojuri:idem:tenant:${tenantId}`;
}

function txnKey(tenantId: string, transactionId: string): string {
  return `ojuri:idem:txn:${tenantId}:${transactionId}`;
}

/**
 * Exported for tests. `compress` is a parameter (not the env-derived
 * COMPRESS constant) so the test suite can exercise both branches
 * without mutating process.env.
 */
export function encodeEntry(entry: StoredEntry, compress: boolean = COMPRESS): string {
  const json = JSON.stringify(entry);
  if (!compress) return json;
  return COMPRESS_PREFIX + gzipSync(json).toString("base64");
}

export function decodeEntry(raw: string): StoredEntry | null {
  try {
    if (raw.startsWith(COMPRESS_PREFIX)) {
      const buf = Buffer.from(raw.slice(COMPRESS_PREFIX.length), "base64");
      return JSON.parse(gunzipSync(buf).toString("utf8"));
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default IdempotencyService;
