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

  private featuresToHash(features: CombinedFeatures): Record<string, string> {
    return {
      velocity_1h: String(features.velocity_1h),
      velocity_24h: String(features.velocity_24h),
      velocity_7d: String(features.velocity_7d),
      avg_amount_30d: String(features.avg_amount_30d),
      std_amount_30d: String(features.std_amount_30d),
      time_since_last_txn: String(features.time_since_last_txn),
      pagerank: String(features.pagerank),
      clustering_coef: String(features.clusteringCoef),
      community_id: String(features.communityId),
      degree_centrality: String(features.degreeCentrality),
      in_degree: String(features.inDegree),
      out_degree: String(features.outDegree),
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
