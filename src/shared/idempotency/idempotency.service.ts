import { createHash, randomUUID } from "crypto";
import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import IdempotencyKeyRepo from "./repositories/idempotency-key.repo";
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
  // Concurrent in-flight request for the same key — caller should
  // return 409 (or retry the lookup after a short delay; predict
  // controller currently polls inline before giving up).
  | { kind: "in_flight" };

interface IdempotencyInput {
  tenantId: string;
  apiKeyId: string | null;
  key: string;
}

interface AcquiredLock {
  release(): Promise<void>;
}

@singleton()
class IdempotencyService {
  constructor(
    private readonly repo: IdempotencyKeyRepo,
    private readonly redis: RedisClient
  ) {}

  /**
   * Look up an existing idempotent response, or return `miss`. A
   * `conflict` outcome means the same key was reused with a
   * different request body — clients should treat this as 422.
   *
   * The storage key is composed of `apiKeyId|key` so two unrelated
   * clients of the same tenant who happen to share an Idempotency-Key
   * value get isolation — without this, client A's response (with
   * sensitive `fraud_probability` and `reason_codes`) leaks to
   * client B on the first replay.
   */
  async lookup(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyOutcome> {
    const storageKey = composeKey(input);
    const row = await this.repo.findByCompositeKey(input.tenantId, storageKey);
    if (!row) return { kind: "miss" };
    if (new Date(row.expiresAt).getTime() < Date.now()) return { kind: "miss" };
    if (row.requestHash !== input.requestHash) return { kind: "conflict" };

    return {
      kind: "replay",
      response:
        typeof row.response === "string"
          ? JSON.parse(row.response as unknown as string)
          : row.response,
    };
  }

  async store(input: IdempotencyInput & {
    requestHash: string;
    response: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? IDEMPOTENCY_TTL_MS));

    try {
      await this.repo.insertIgnoringConflict({
        tenantId: input.tenantId,
        key: composeKey(input),
        requestHash: input.requestHash,
        response: input.response,
        expiresAt,
      });
    } catch (err) {
      log.error("store", "Failed to persist idempotency record", { err: String(err) });
    }
  }

  /**
   * Acquire a Redis-backed lock so only one concurrent request for a
   * given (tenant, apiKey, key) tuple runs the expensive ML path. The
   * losers see `in_flight` and the predict controller polls for the
   * leader's stored response before giving up.
   *
   * Returns null when the lock is held by another in-flight request.
   * The TTL guards against a leader crash leaving the lock dangling.
   */
  async acquireLock(input: IdempotencyInput): Promise<AcquiredLock | null> {
    const client = this.redis.get();
    const lockKey = `ojuri:idem:${input.tenantId}:${composeKey(input)}`;
    const lockValue = randomUUID();
    // ioredis: SET key value NX EX seconds. Returns "OK" on success,
    // null when the key already exists.
    const acquired = await client.set(lockKey, lockValue, "EX", LOCK_TTL_SECONDS, "NX");
    if (acquired !== "OK") return null;

    return {
      release: async () => {
        // CAS release — only delete the lock if we still own it. Avoids
        // releasing a TTL-extended lock that another request now owns.
        const releaseScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        try {
          await client.eval(releaseScript, 1, lockKey, lockValue);
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
   * Returns the same shape as `lookup`; the caller uses this to turn
   * `in_flight` into either `replay` (the leader finished) or a 409
   * (still in flight after the poll window).
   */
  async waitForReplay(input: IdempotencyInput & { requestHash: string }): Promise<IdempotencyOutcome> {
    const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_INTERVAL_MS);
      const outcome = await this.lookup(input);
      if (outcome.kind === "replay" || outcome.kind === "conflict") {
        return outcome;
      }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default IdempotencyService;
