import { injectable } from "tsyringe";
import Redis from "ioredis";
import RedisClient from "@shared/redis-client/redis-client";
import appConfig from "@config/app.config";
import { createServiceLogger, TraceContext } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import { createCircuitBreaker } from "@shared/circuit-breaker/circuit-breaker";
import type CircuitBreaker from "opossum";

const featureLogger = createServiceLogger("FeatureService");

/**
 * Raw Redis hash for a sender. Keys are catalogue-feature names; the
 * Redis writer (PAA) is responsible for matching them.
 *
 * `predict.service.ts` consumes this map and hands it to the
 * catalogue-driven `buildFeatures()` to produce the ONNX input
 * tensor. This service stays narrow: fetch + circuit-break, nothing
 * else.
 */
export type RedisFeatureSnapshot = Record<string, unknown>;

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
      async (senderId: string) => this.fetchFeaturesFromRedis(senderId),
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
   * Fetch the `features:{senderId}` Redis hash. Returns the raw
   * snapshot and a flag for whether the values came from Redis or
   * the population-default fallback.
   *
   * Catalogue-aligned vector construction happens downstream in
   * `predict.service.ts` via `buildFeatures()`. This service stays
   * narrow: I/O only.
   */
  async getFeatures(
    senderId: string,
    _timestamp: number
  ): Promise<{ snapshot: RedisFeatureSnapshot; isDefault: boolean }> {
    const traceId = TraceContext.getTraceId();

    try {
      const snapshot: RedisFeatureSnapshot = await this.featureCircuitBreaker.fire(senderId);
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
   * coerces.
   */
  private async fetchFeaturesFromRedis(senderId: string): Promise<RedisFeatureSnapshot> {
    const key = `features:${senderId}`;
    const traceId = TraceContext.getTraceId();

    const features = await Promise.race([
      this.redisClient.hgetall(key),
      this.timeout(this.featureTimeout),
    ]);

    if (!features || Object.keys(features).length === 0) {
      featureLogger.debug("fetchFeaturesFromRedis", "No features found in Redis, using defaults", {
        traceId,
        senderId,
        key,
      });
      return { ...DEFAULT_REDIS_SNAPSHOT };
    }

    return features as RedisFeatureSnapshot;
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
