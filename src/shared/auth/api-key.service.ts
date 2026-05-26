import { createHash, randomBytes } from "crypto";
import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import ApiKeyRepo from "./repositories/api-key.repo";
import { ApiKeyContext } from "./api-key.types";

const log = createServiceLogger("ApiKeyService");

const KEY_PREFIX_LENGTH = 12;
const KEY_SECRET_BYTES = 24;

interface CacheEntry {
  context: ApiKeyContext;
  expiresAt: number;
}

@singleton()
class ApiKeyService {
  // Keyed by sha256(token), NOT the raw plaintext — a heap dump no
  // longer leaks live API keys. JS Map iteration is insertion-ordered,
  // so a delete-then-set on hit gives us a poor-man's LRU. Negative
  // results are NOT cached to prevent an attacker from OOMing the
  // process by spraying random invalid tokens.
  private cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 30_000;
  private readonly cacheCap = 10_000;

  constructor(private readonly repo: ApiKeyRepo) {}

  /**
   * Issue a new API key. Returns the plaintext token exactly once —
   * the caller is responsible for handing it to the user; only the
   * hash is persisted.
   */
  async issue(input: {
    tenantId: string;
    name: string;
    scope?: string;
    rateLimitPerMinute?: number;
    expiresAt?: Date;
  }): Promise<{ id: string; token: string; keyPrefix: string }> {
    const keyPrefix = randomBytes(KEY_PREFIX_LENGTH / 2).toString("hex");
    const secret = randomBytes(KEY_SECRET_BYTES).toString("base64url");
    const token = `fdk_${keyPrefix}_${secret}`;
    const keyHash = createHash("sha256").update(token).digest("hex");

    const row = await this.repo.save({
      tenantId: input.tenantId,
      name: input.name,
      keyPrefix,
      keyHash,
      scope: input.scope ?? "predict",
      rateLimitPerMinute: input.rateLimitPerMinute ?? 600,
      expiresAt: input.expiresAt ?? null,
      isActive: true,
    });

    log.info("issue", "API key issued", { id: row.id, tenantId: input.tenantId, keyPrefix });

    return { id: row.id, token, keyPrefix };
  }

  /**
   * Resolve a presented token to an ApiKeyContext. Returns null when
   * the key is unknown, revoked, expired, or inactive. Hot path —
   * results are cached for 30 s to avoid hammering Postgres.
   */
  async verify(token: string | undefined): Promise<ApiKeyContext | null> {
    if (!token || !token.startsWith("fdk_")) {
      return null;
    }

    const now = Date.now();
    const keyHash = createHash("sha256").update(token).digest("hex");
    const cached = this.cache.get(keyHash);
    if (cached && cached.expiresAt > now) {
      // Bump to the most-recent end of the insertion order for LRU.
      this.cache.delete(keyHash);
      this.cache.set(keyHash, cached);
      return cached.context;
    }
    if (cached) this.cache.delete(keyHash);

    const row = await this.repo.findByHash(keyHash);

    if (!row || row.revokedAt) {
      // Deliberately NOT cached — an attacker spraying random tokens
      // could otherwise wedge the heap with junk entries.
      return null;
    }

    if (row.expiresAt && new Date(row.expiresAt).getTime() < now) {
      return null;
    }

    const context: ApiKeyContext = {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      scope: row.scope,
      rateLimitPerMinute: row.rateLimitPerMinute,
    };

    // Bounded LRU: evict the oldest entry when at capacity.
    if (this.cache.size >= this.cacheCap) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(keyHash, { context, expiresAt: now + this.cacheTtlMs });

    // Fire-and-forget — must not block the predict hot path.
    this.repo
      .touchLastUsed(row.id)
      .catch((err) => log.error("verify", "Failed to update lastUsedAt", { err: String(err) }));

    return context;
  }

  async revoke(id: string, reason?: string): Promise<boolean> {
    const n = await this.repo.revoke(id, reason ?? null);
    this.cache.clear();
    return n > 0;
  }

  async list(tenantId?: string): Promise<Partial<unknown>[]> {
    return this.repo.listAll(tenantId);
  }
}

export default ApiKeyService;
