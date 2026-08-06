import { randomUUID } from "crypto";
import appConfig from "@config/app.config";
import { createServiceLogger } from "@utils/service-logger";
import { redisClient } from "./redis-client";

const log = createServiceLogger("LeaderLease");

const LEASE_KEY = "ojuri:paa:leader";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// PAA keeps the graph and velocity windows in process memory, so a
// second consumer would split the partitions and write half-graph
// features to the Redis keys RDA decides on. Only the lease holder runs.
class LeaderLeaseService {
  private readonly id = randomUUID();
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private held = false;
  private lastRenewOkAt = 0;
  private onLost: (() => void) | null = null;

  constructor() {
    this.ttlMs = appConfig.paa.leaderLeaseTtlMs;
    // Must stay well under the TTL: renewing less often than the lease
    // expires would let it lapse while we still think we hold it.
    this.renewIntervalMs = Math.max(50, Math.floor(this.ttlMs / 3));
  }

  isHeld(): boolean {
    return this.held;
  }

  leaseId(): string {
    return this.id;
  }

  // A rolling deploy starts the successor before the incumbent
  // terminates, so a single failed attempt would exit into a restart
  // backoff that outlasts the handover it was waiting for.
  async acquireWithRetry(timeoutMs: number): Promise<boolean> {
    const giveUpAt = Date.now() + timeoutMs;
    const retryDelayMs = 1000;

    while (Date.now() < giveUpAt) {
      if (await this.acquire()) return true;
      log.info("acquireWithRetry", "Lease held elsewhere — waiting for handover", {
        retryDelayMs,
        remainingMs: giveUpAt - Date.now(),
      });
      await sleep(retryDelayMs);
    }
    return false;
  }

  async acquire(): Promise<boolean> {
    try {
      const res = await redisClient
        .get()
        .set(LEASE_KEY, this.id, "PX", this.ttlMs, "NX");
      this.held = res === "OK";
      if (this.held) {
        this.lastRenewOkAt = Date.now();
        log.success("acquire", "Acquired PAA leader lease", { id: this.id, ttlMs: this.ttlMs });
      } else {
        const holder = await redisClient.get().get(LEASE_KEY);
        log.error("acquire", "Another PAA instance holds the leader lease — refusing to consume", {
          id: this.id,
          holder,
        });
      }
      return this.held;
    } catch (err) {
      // Redis unreachable. Fail closed: PAA writes the features RDA
      // decides on, and a split graph is worse than no update.
      log.error("acquire", "Could not reach Redis for the leader lease — refusing to consume", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.held = false;
      return false;
    }
  }

  startRenewal(onLost: () => void): void {
    if (this.timer) return;
    this.onLost = onLost;
    this.timer = setInterval(() => {
      this.renew().catch((err) =>
        log.error("renew", "Lease renewal threw", {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }, this.renewIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  private async renew(): Promise<void> {
    if (!this.held) return;
    // Extend only while we still own it — a lease that expired and was
    // taken by another instance must not be stolen back.
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    let renewed = 0;
    try {
      renewed = Number(await redisClient.get().eval(script, 1, LEASE_KEY, this.id, this.ttlMs));
    } catch (err) {
      // Redis unreachable is not "still the leader". The key expires on
      // the server regardless of whether we can see it, so a partition
      // that outlasts the TTL means a challenger has already taken over
      // while this instance keeps consuming — split brain from a single
      // failover. Self-fence on elapsed time, not just on a confirmed
      // loss.
      const staleFor = Date.now() - this.lastRenewOkAt;
      log.warn("renew", "Lease renewal failed", {
        error: err instanceof Error ? err.message : String(err),
        staleForMs: staleFor,
        ttlMs: this.ttlMs,
      });
      if (staleFor >= this.ttlMs) this.surrender("renewal unreachable past the lease TTL");
      return;
    }

    if (renewed === 1) {
      this.lastRenewOkAt = Date.now();
      return;
    }

    this.surrender("another instance has taken over");
  }

  private surrender(reason: string): void {
    if (!this.held) return;
    this.held = false;
    log.error("renew", "Lost the PAA leader lease", { id: this.id, reason });
    this.onLost?.();
  }

  async release(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.held) return;
    this.held = false;

    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    try {
      await redisClient.get().eval(script, 1, LEASE_KEY, this.id);
      log.info("release", "Released PAA leader lease", { id: this.id });
    } catch (err) {
      log.warn("release", "Lease release failed; it will expire on TTL", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const leaderLease = new LeaderLeaseService();
export default LeaderLeaseService;
