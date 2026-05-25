import { createHash } from "crypto";
import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import IdempotencyKeyRepo from "./repositories/idempotency-key.repo";

const log = createServiceLogger("IdempotencyService");

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export type IdempotencyOutcome =
  | { kind: "miss" }
  | { kind: "replay"; response: Record<string, unknown> }
  | { kind: "conflict" };

interface IdempotencyInput {
  tenantId: string;
  apiKeyId: string | null;
  key: string;
}

@singleton()
class IdempotencyService {
  constructor(private readonly repo: IdempotencyKeyRepo) {}

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

  static hashRequest(body: unknown): string {
    return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
  }
}

function composeKey(input: IdempotencyInput): string {
  return `${input.apiKeyId ?? "anon"}|${input.key}`;
}

export default IdempotencyService;
