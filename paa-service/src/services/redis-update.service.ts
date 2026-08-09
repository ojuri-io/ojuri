import { createServiceLogger, TraceContext } from "@utils/service-logger";
import { metricsService } from "@utils/metrics";
import { redisClient } from "./redis-client";
import { CombinedFeatures, PairFeatures } from "./types";

const log = createServiceLogger("RedisUpdateService");

interface PendingPairUpdate {
  senderId: string;
  receiverId: string;
  features: PairFeatures;
}

class RedisUpdateService {
  private readonly featureTTL = 604800; // 7 days
  // Pair windows are 30d; a 7d TTL would reset established pairs to
  // "first send" after a quiet week.
  private readonly pairFeatureTTL = 2592000; // 30 days
  private pendingUpdates: Map<string, CombinedFeatures> = new Map();
  private pendingPairUpdates: Map<string, PendingPairUpdate> = new Map();
  private pendingReceiverCounts: Map<string, number> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly batchSize = 100;

  constructor() {
    this.startBatchFlush();
  }

  queueUpdate(userId: string, features: CombinedFeatures): void {
    this.pendingUpdates.set(userId, features);
    this.maybeFlush();
  }

  queuePairUpdate(senderId: string, receiverId: string, features: PairFeatures): void {
    this.pendingPairUpdates.set(`${senderId}:${receiverId}`, { senderId, receiverId, features });
    this.maybeFlush();
  }

  /**
   * Partial update: refreshes the receiver's inbound-count field even
   * when the receiver never sends (a pure mule endpoint has no full
   * feature update of its own).
   */
  queueReceiverCount(receiverId: string, lifetimeTxCount: number): void {
    this.pendingReceiverCounts.set(receiverId, lifetimeTxCount);
    this.maybeFlush();
  }

  private maybeFlush(): void {
    const pending =
      this.pendingUpdates.size + this.pendingPairUpdates.size + this.pendingReceiverCounts.size;
    if (pending >= this.batchSize) {
      this.flushUpdates();
    }
  }

  private startBatchFlush(): void {
    this.flushInterval = setInterval(() => {
      this.flushUpdates();
    }, 10000);
  }

  private async flushUpdates(): Promise<void> {
    if (
      this.pendingUpdates.size === 0 &&
      this.pendingPairUpdates.size === 0 &&
      this.pendingReceiverCounts.size === 0
    ) {
      return;
    }

    const updates = new Map(this.pendingUpdates);
    const pairUpdates = new Map(this.pendingPairUpdates);
    const receiverCounts = new Map(this.pendingReceiverCounts);
    this.pendingUpdates.clear();
    this.pendingPairUpdates.clear();
    this.pendingReceiverCounts.clear();

    await this.batchUpdateFeatures(updates, pairUpdates, receiverCounts);
  }

  private async batchUpdateFeatures(
    updates: Map<string, CombinedFeatures>,
    pairUpdates: Map<string, PendingPairUpdate>,
    receiverCounts: Map<string, number>
  ): Promise<void> {
    if (updates.size === 0 && pairUpdates.size === 0 && receiverCounts.size === 0) return;

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

      for (const { senderId, receiverId, features } of pairUpdates.values()) {
        const key = `features:pair:${senderId}:${receiverId}`;
        pipeline.hset(key, this.pairFeaturesToHash(features));
        pipeline.expire(key, this.pairFeatureTTL);
      }

      for (const [receiverId, lifetimeTxCount] of receiverCounts) {
        const key = `features:${receiverId}`;
        pipeline.hset(key, { recipient_lifetime_tx_count: String(lifetimeTxCount) });
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
      // Velocity (catalogue indices 0-5).
      velocity_1m: String(features.velocity_1m),
      velocity_5m: String(features.velocity_5m),
      velocity_15m: String(features.velocity_15m),
      velocity_1h: String(features.velocity_1h),
      velocity_24h: String(features.velocity_24h),
      velocity_7d: String(features.velocity_7d),

      // Amount aggregates (catalogue indices 6-9).
      amount_mean_24h: String(features.amount_mean_24h),
      amount_max_24h: String(features.amount_max_24h),
      amount_mean_30d: String(features.avg_amount_30d),
      amount_std_30d: String(features.std_amount_30d),

      // Receiver diversity (catalogue indices 10, 11).
      unique_receivers_24h: String(features.unique_receivers_24h),
      unique_receivers_7d: String(features.unique_receivers_7d),

      // Graph block (catalogue indices 18-25).
      graph_pagerank: String(features.pagerank),
      graph_clustering_coef: String(features.clusteringCoef),
      graph_community_id: String(features.communityId),
      graph_in_degree: String(features.inDegree),
      graph_out_degree: String(features.outDegree),
      graph_is_hub: String(features.isHub),
      graph_shortest_path_to_fraud: String(features.shortestPathToFraud),
      graph_neighborhood_fraud_rate: String(features.neighborhoodFraudRate),

      // Receiver block (catalogue index 44) — this user's own inbound
      // count, read from the RECEIVER's hash by RDA.
      recipient_lifetime_tx_count: String(features.recipientLifetimeTxCount),

      // Calendar (catalogue index 63).
      hour_dev_from_sender_norm: String(features.hour_dev_from_norm),

      // Bookkeeping — not in catalogue, kept for ops/debugging.
      updated_at: String(features.updated_at),
    };
  }

  /**
   * Pair hash fields mirror catalogue names (indices 12-16). Values
   * are the state as of the pair's last completed transaction:
   * `pair_time_since_last_send` is the gap between the pair's two most
   * recent sends, and a hash existing at all means the pair has
   * transacted before (`pair_is_first_send=0`; a missing hash falls
   * back to the catalogue default of 1).
   */
  private pairFeaturesToHash(features: PairFeatures): Record<string, string> {
    return {
      pair_is_first_send: "0",
      pair_prior_send_count: String(features.priorSendCount),
      pair_time_since_last_send: String(features.secondsSincePrevSend),
      pair_round_trip_count_30d: String(features.roundTripCount30d),
      pair_amount_mean_30d: String(features.amountMean30d),
    };
  }

  // These writes land in the feature keys RDA reads on the decision
  // path, so an instance that lost the leader lease must drop its
  // buffer rather than flush a partial-graph snapshot over whatever the
  // new leader has already written.
  stop({ discard = false } = {}): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    if (!discard) {
      this.flushUpdates();
      return;
    }

    const dropped =
      this.pendingUpdates.size + this.pendingPairUpdates.size + this.pendingReceiverCounts.size;
    this.pendingUpdates.clear();
    this.pendingPairUpdates.clear();
    this.pendingReceiverCounts.clear();
    log.warn("stop", "Discarded buffered Redis writes after losing the leader lease", { dropped });
  }
}

export const redisUpdateService = new RedisUpdateService();
export default RedisUpdateService;
