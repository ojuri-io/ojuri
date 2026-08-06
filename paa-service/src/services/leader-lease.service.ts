import { randomUUID } from "crypto";
import appConfig from "@config/app.config";
import { createServiceLogger } from "@utils/service-logger";
import { redisClient } from "./redis-client";

const log = createServiceLogger("LeaderLease");

const LEASE_KEY = "ojuri:paa:leader";

/**
 * PAA holds the transaction graph and velocity windows in process
 * memory. A second member of the `pattern-analysis` consumer group
 * splits the partition assignment, so each replica runs PageRank/Louvain
 * over a partial graph and writes those degraded features to Redis for
 * RDA to consume on the decision path.
 *
 * The previous guard only logged the breach; both replicas kept writing.
 * A Redis lease actually fences: the loser never starts consuming. The
 * TTL is deliberately longer than the renew interval so a deliberate
 * rolling-restart overlap resolves itself rather than flapping, and
 * `release()` on graceful shutdown hands over immediately.
 */
class LeaderLeaseService {
  private readonly id = randomUUID();
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private held = false;
  private onLost: (() => void) | null = null;

  constructor() {
    this.ttlMs = appConfig.paa.leaderLeaseTtlMs;
    this.renewIntervalMs = Math.max(1000, Math.floor(this.ttlMs / 3));
  }

  isHeld(): boolean {
    return this.held;
  }

  leaseId(): string {
    return this.id;
  }

  async acquire(): Promise<boolean> {
    try {
      const res = await redisClient
        .get()
        .set(LEASE_KEY, this.id, "PX", this.ttlMs, "NX");
      this.held = res === "OK";
      if (this.held) {
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
      log.warn("renew", "Lease renewal failed; will retry on the next tick", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (renewed === 1) return;

    this.held = false;
    log.error("renew", "Lost the PAA leader lease — another instance has taken over", {
      id: this.id,
    });
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
