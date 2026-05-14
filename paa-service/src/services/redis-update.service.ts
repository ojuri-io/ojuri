import { createServiceLogger, TraceContext } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { redisClient } from "./redis-client";
import { CombinedFeatures } from "./types";

const log = createServiceLogger("RedisUpdateService");

class RedisUpdateService {
  private readonly featureTTL = 604800; // 7 days
  private pendingUpdates: Map<string, CombinedFeatures> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly batchSize = 100;

  constructor() {
    this.startBatchFlush();
  }

  queueUpdate(userId: string, features: CombinedFeatures): void {
    this.pendingUpdates.set(userId, features);

    if (this.pendingUpdates.size >= this.batchSize) {
      this.flushUpdates();
    }
  }

  private startBatchFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flushUpdates();
    }, 10000);
  }

  private async flushUpdates(): Promise<void> {
    if (this.pendingUpdates.size === 0) return;

    const updates = new Map(this.pendingUpdates);
    this.pendingUpdates.clear();

    await this.batchUpdateFeatures(updates);
  }

  private async batchUpdateFeatures(updates: Map<string, CombinedFeatures>): Promise<void> {
    if (updates.size === 0) return;

    const startTime = Date.now();
    let successCount = 0;
    let errorCount = 0;

    try {
      const redis = redisClient.get();
      const pipeline = redis.pipeline();

      for (const [userId, features] of updates) {
        const key = `features:${userId}`;
        pipeline.hset(key, this.featuresToHash(features));
        pipeline.expire(key, this.featureTTL);
      }

      const results = await pipeline.exec();

      if (results) {
        for (const [err] of results) {
          if (err) {
            errorCount++;
          } else {
            successCount++;
          }
        }
      }

      const duration = Date.now() - startTime;

      if (successCount > 0) {
        metricsService.recordRedisUpdateSuccess();
      }
      if (errorCount > 0) {
        metricsService.recordRedisUpdateError();
      }

      log.success("batchUpdateFeatures", "Batch feature update completed", {
        total: updates.size,
        success: successCount / 2,
        errors: errorCount / 2,
        durationMs: duration,
      });
    } catch (err) {
      log.error("batchUpdateFeatures", "Failed to batch update features in Redis", {
        error: err instanceof Error ? err.message : String(err),
      });
      metricsService.recordRedisUpdateError();
    }
  }

  /**
   * Hash field names follow the canonical names in
   * `models/feature-catalog.v1.json`. RDA's `buildFeatures()` reads
   * `features:{senderId}` and looks up each catalogue feature by its
   * `name` — so any rename here MUST keep the keys in lock-step with
   * the catalogue. The local PAA `CombinedFeatures` type retains its
   * own names; this is the only contract boundary that crosses the
   * Redis wire.
   */
  private featuresToHash(features: CombinedFeatures): Record<string, string> {
    return {
      // Velocity (catalogue indices 3, 4, 5 — PAA windows; finer 1m/5m/15m left to extensions).
      velocity_1h: String(features.velocity_1h),
      velocity_24h: String(features.velocity_24h),
      velocity_7d: String(features.velocity_7d),

      // Amount aggregates (catalogue indices 8, 9).
      amount_mean_30d: String(features.avg_amount_30d),
      amount_std_30d: String(features.std_amount_30d),

      // Pair-level (catalogue index 14).
      pair_time_since_last_send: String(features.time_since_last_txn),

      // Graph block (catalogue indices 18-22).
      graph_pagerank: String(features.pagerank),
      graph_clustering_coef: String(features.clusteringCoef),
      graph_community_id: String(features.communityId),
      graph_in_degree: String(features.inDegree),
      graph_out_degree: String(features.outDegree),

      // Bookkeeping — not in catalogue, kept for ops/debugging.
      updated_at: String(features.updated_at),
    };
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flushUpdates();
  }
}

export const redisUpdateService = new RedisUpdateService();
export default RedisUpdateService;
