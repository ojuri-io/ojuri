import { createHash, randomUUID } from "crypto";
import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import RedisClient from "@shared/redis-client/redis-client";

const log = createServiceLogger("IdempotencyService");

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const LOCK_TTL_SECONDS = 15;
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_POLL_TIMEOUT_MS = 3_000;

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
 * Redis-backed idempotency cache for `POST /v1/predict`. Replaces an
 * earlier Postgres table — every operation here is sub-millisecond
 * against a healthy local Redis vs. ~1–10 ms round-trips against
 * Postgres for a cache that's never the system of record.
 *
 * Composite key includes the API key ID so two unrelated callers of
 * the same tenant who happen to share an Idempotency-Key value get
 * isolation — without it, callerA's response would leak to callerB
 * on the first replay.
 */
@singleton()
class IdempotencyService {
  constructor(private readonly redis: RedisClient) {}

  async lookup(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyOutcome> {
    const raw = await this.redis.get().get(respKey(input));
    if (!raw) return { kind: "miss" };

    let entry: StoredEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      log.warn("lookup", "Stored entry is not valid JSON; treating as miss");
      return { kind: "miss" };
    }
    if (entry.requestHash !== input.requestHash) return { kind: "conflict" };
    return { kind: "replay", response: entry.response };
  }

  async store(input: IdempotencyInput & {
    requestHash: string;
    response: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<void> {
    const ttlSec = Math.max(1, Math.floor((input.ttlMs ?? IDEMPOTENCY_TTL_MS) / 1000));
    const entry: StoredEntry = { requestHash: input.requestHash, response: input.response };
    try {
      await this.redis.get().set(respKey(input), JSON.stringify(entry), "EX", ttlSec);
    } catch (err) {
      // Audit-grade durability isn't the goal here — losing a replay
      // record only means a retry recomputes. Log and move on.
      log.error("store", "Failed to persist idempotency record", { err: String(err) });
    }
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

  /**
   * Wait briefly for another in-flight request to land its response.
   * Returns `replay` when the leader writes, `conflict` if it wrote a
   * different request body, `in_flight` if the poll window expires.
   */
  async waitForReplay(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyOutcome> {
    const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_INTERVAL_MS);
      const outcome = await this.lookup(input);
      if (outcome.kind === "replay" || outcome.kind === "conflict") return outcome;
    }
    return { kind: "in_flight" };
  }

  static hashRequest(body: unknown): string {
    return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default IdempotencyService;
