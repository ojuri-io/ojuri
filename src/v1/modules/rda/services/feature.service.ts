import { injectable } from "tsyringe";
import Redis from "ioredis";
import RedisClient from "@shared/redis-client/redis-client";
import appConfig from "@config/app.config";
import { createServiceLogger, TraceContext } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import { createCircuitBreaker } from "@shared/circuit-breaker/circuit-breaker";
import type CircuitBreaker from "opossum";
import { RedisFeatureSnapshot } from "./feature.types";

const featureLogger = createServiceLogger("FeatureService");

/**
 * Default snapshot returned on Redis miss / breaker-open. These are
 * population averages for the legacy catalogue names; the feature
 * builder reads missing keys as catalogue defaults, but seeding
 * sensible non-zero numbers keeps demo predictions plausible when no
 * sender has been seen.
 */
const DEFAULT_REDIS_SNAPSHOT: RedisFeatureSnapshot = {
  velocity_1h: 2.5,
  velocity_24h: 15.0,
  velocity_7d: 75.0,
  amount_mean_30d: 25000.0,
  amount_std_30d: 15000.0,
  graph_pagerank: 0.15,
  graph_clustering_coef: 0.35,
  pair_time_since_last_send: 3600,
};

@injectable()
class FeatureService {
  private redisClient: Redis;
  private featureCircuitBreaker!: CircuitBreaker<any[], any>;
  private readonly featureTimeout: number;

  constructor(redisClient: RedisClient) {
    this.redisClient = redisClient.get();
    this.featureTimeout = appConfig.redis.featureTimeout;
    this.setupCircuitBreaker();
  }

  private setupCircuitBreaker(): void {
    this.featureCircuitBreaker = createCircuitBreaker(
      async (senderId: string, receiverId: string) =>
        this.fetchFeaturesFromRedis(senderId, receiverId),
      {
        name: "redis-features",
        timeout: this.featureTimeout,
        errorThresholdPercentage: appConfig.circuitBreaker.redis.errorThresholdPercentage,
        resetTimeout: appConfig.circuitBreaker.redis.resetTimeout,
        fallback: () => {
          featureLogger.warn("fallback", "Using default features due to Redis circuit breaker fallback", {
            traceId: TraceContext.getTraceId(),
          });
          return { ...DEFAULT_REDIS_SNAPSHOT };
        },
      }
    );
  }

  /**
   * Fetch the sender's `features:{senderId}` hash, the pair-scoped
   * `features:pair:{senderId}:{receiverId}` hash, and the receiver's
   * `recipient_*` fields — one pipelined round trip. Returns the
   * merged snapshot and a flag for whether the sender values came
   * from Redis or the population-default fallback.
   *
   * Catalogue-aligned vector construction happens downstream in
   * `predict.service.ts` via `buildFeatures()`. This service stays
   * narrow: I/O only.
   */
  async getFeatures(
    senderId: string,
    receiverId: string,
    _timestamp: number
  ): Promise<{ snapshot: RedisFeatureSnapshot; isDefault: boolean }> {
    const traceId = TraceContext.getTraceId();

    try {
      const snapshot: RedisFeatureSnapshot = await this.featureCircuitBreaker.fire(
        senderId,
        receiverId
      );
      const isDefault = this.isDefaultSnapshot(snapshot);

      if (!isDefault) {
        metricsService.recordCacheHit();
        featureLogger.success("getFeatures", "Features retrieved from Redis cache", {
          traceId,
          senderId,
        });
      } else {
        metricsService.recordCacheMiss();
        featureLogger.debug("getFeatures", "Using default features (cache miss)", {
          traceId,
          senderId,
        });
      }

      return { snapshot, isDefault };
    } catch (err) {
      featureLogger.error("getFeatures", "Error retrieving features", {
        traceId,
        senderId,
        error: err instanceof Error ? err.message : String(err),
      });
      metricsService.recordCacheMiss();
      return { snapshot: { ...DEFAULT_REDIS_SNAPSHOT }, isDefault: true };
    }
  }

  /**
   * Fetch features from Redis. Keys are stored as catalogue feature
   * names; values are stringified numerics that the feature builder
   * coerces. The receiver hash contributes ONLY its `recipient_*`
   * fields — merging it wholesale would overwrite the sender's
   * velocity/graph values with the receiver's.
   */
  private async fetchFeaturesFromRedis(
    senderId: string,
    receiverId: string
  ): Promise<RedisFeatureSnapshot> {
    const senderKey = `features:${senderId}`;
    const pairKey = `features:pair:${senderId}:${receiverId}`;
    const receiverKey = `features:${receiverId}`;
    const traceId = TraceContext.getTraceId();

    const [senderHash, pairHash, receiverHash] = await Promise.race([
      this.pipelinedHashes(senderKey, pairKey, receiverKey),
      this.timeout(this.featureTimeout),
    ]);

    const hasSenderFeatures = senderHash && Object.keys(senderHash).length > 0;
    if (!hasSenderFeatures) {
      featureLogger.debug("fetchFeaturesFromRedis", "No features found in Redis, using defaults", {
        traceId,
        senderId,
        key: senderKey,
      });
    }

    const snapshot: RedisFeatureSnapshot = hasSenderFeatures
      ? { ...senderHash }
      : { ...DEFAULT_REDIS_SNAPSHOT };

    if (pairHash) {
      for (const [field, value] of Object.entries(pairHash)) {
        snapshot[field] = value;
      }
    }
    if (receiverHash) {
      for (const [field, value] of Object.entries(receiverHash)) {
        if (field.startsWith("recipient_")) snapshot[field] = value;
      }
    }

    return snapshot;
  }

  private async pipelinedHashes(
    ...keys: string[]
  ): Promise<Array<Record<string, string> | null>> {
    const pipeline = this.redisClient.pipeline();
    for (const key of keys) pipeline.hgetall(key);
    const results = await pipeline.exec();
    if (!results) throw new Error("Redis pipeline returned no results");
    return results.map(([err, value]) => {
      if (err) throw err;
      return (value ?? null) as Record<string, string> | null;
    });
  }

  /**
   * "Default" here means "we got nothing meaningful from Redis". A
   * snapshot matching the seeded defaults still rides the same code
   * path as a cache miss — neither has real per-sender values.
   */
  private isDefaultSnapshot(snapshot: RedisFeatureSnapshot): boolean {
    return (
      Number(snapshot.velocity_1h) === DEFAULT_REDIS_SNAPSHOT.velocity_1h &&
      Number(snapshot.velocity_24h) === DEFAULT_REDIS_SNAPSHOT.velocity_24h
    );
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Feature retrieval timeout (${ms}ms)`)), ms);
    });
  }

  isReady(): boolean {
    return this.redisClient.status === "ready";
  }
}

export default FeatureService;
