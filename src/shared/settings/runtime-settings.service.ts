import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import RuntimeSettingRepo from "./repositories/runtime-setting.repo";

const log = createServiceLogger("RuntimeSettings");

/**
 * Time-bounded in-memory cache for runtime settings.
 *
 * The fraud-threshold read sits on the predict hot path. Hitting
 * Postgres on every predict would add ~1ms and a connection — neither
 * acceptable. Instead the service refreshes from the DB at boot and on
 * a `REFRESH_MS` timer, so the predict path's `getFraudThreshold()`
 * call is a sync map lookup.
 *
 * PUTs invalidate the cache immediately so the UI's confirm toast
 * doesn't lie. With multiple RDA replicas the timer interval becomes
 * the worst-case propagation delay for a settings change. Reasonable
 * for a threshold knob; if we add settings that need stricter
 * consistency, swap this for NOTIFY/LISTEN or Redis pub-sub.
 */
@singleton()
class RuntimeSettingsService {
  private static readonly REFRESH_MS = 30_000;
  private cache = new Map<string, unknown>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly repo: RuntimeSettingRepo) {}

  /**
   * Warm the cache and start the refresh loop. Idempotent — safe to
   * call from both `server.ts` boot and from tests' setup hooks.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) =>
        log.warn("refresh", "Failed to refresh runtime settings cache", {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }, RuntimeSettingsService.REFRESH_MS);
    log.success("start", "Runtime settings cache primed", {
      keys: Array.from(this.cache.keys()),
    });
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.started = false;
  }

  /**
   * Sync read used by the predict hot path. Returns the cached value
   * (or the env fallback) — never blocks on I/O.
   */
  getFraudThreshold(envFallback: number): number {
    const v = this.cache.get("fraud_threshold");
    return typeof v === "number" && Number.isFinite(v) ? v : envFallback;
  }

  /** Sync read for the predict hot path. 0 = REVIEW band disabled. */
  getReviewMargin(envFallback = 0): number {
    const v = this.cache.get("review_margin");
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : envFallback;
  }

  async listAll() {
    return this.repo.list();
  }

  /**
   * Validate + update + refresh the in-memory cache. Validation lives
   * here (not the controller) so curl callers + the UI get the same
   * error message.
   */
  async update(
    key: string,
    rawValue: unknown,
    updatedBy: string | null
  ): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
    const existing = await this.repo.findByKey(key);
    if (!existing) return { ok: false, reason: `unknown setting key: ${key}` };

    if (existing.type === "number") {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) return { ok: false, reason: "value must be a finite number" };
      const bounds = NUMERIC_BOUNDS[key];
      if (bounds && (n < bounds.min || n > bounds.max)) {
        return {
          ok: false,
          reason: `value must be between ${bounds.min} and ${bounds.max}`,
        };
      }
      const row = await this.repo.updateByKey(key, String(n), updatedBy);
      this.cache.set(key, n);
      log.info("update", "Runtime setting updated", {
        key, previous: existing.value, next: String(n), updatedBy,
      });
      return { ok: true, value: row };
    }

    if (existing.type === "bool") {
      const b = rawValue === true || rawValue === "true" || rawValue === 1 || rawValue === "1";
      const row = await this.repo.updateByKey(key, b ? "true" : "false", updatedBy);
      this.cache.set(key, b);
      return { ok: true, value: row };
    }

    const s = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
    const row = await this.repo.updateByKey(key, s, updatedBy);
    this.cache.set(key, s);
    return { ok: true, value: row };
  }

  private async refresh(): Promise<void> {
    const rows = await this.repo.list();
    const next = new Map<string, unknown>();
    for (const r of rows) {
      next.set(r.key, parseTyped(r.type, r.value));
    }
    this.cache = next;
  }
}

function parseTyped(type: string, value: string): unknown {
  if (type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "bool") return value === "true";
  if (type === "json") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

/**
 * Per-key clamps. Server-side validation the UI cannot bypass. Values
 * outside these ranges have either no operational meaning (negative
 * threshold) or kill the system (threshold so low everything declines).
 */
const NUMERIC_BOUNDS: Record<string, { min: number; max: number }> = {
  fraud_threshold: { min: 0.01, max: 0.99 },
  review_margin: { min: 0, max: 0.5 },
};

export default RuntimeSettingsService;
