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
 * Feature schema - 434 dimensions total
 * This interface represents the key features stored in Redis
 */
export interface UserFeatures {
  velocity_1h: number;
  velocity_24h: number;
  velocity_7d: number;
  avg_amount_30d: number;
  std_amount_30d: number;
  pagerank: number;
  clustering_coef: number;
  time_since_last_txn: number;
  is_weekend: number;
  hour_of_day: number;
  // Additional engineered features would be here (424 more)
  [key: string]: number;
}

/**
 * Default features (population averages) used as fallback
 */
const DEFAULT_FEATURES: UserFeatures = {
  velocity_1h: 2.5,
  velocity_24h: 15.0,
  velocity_7d: 75.0,
  avg_amount_30d: 25000.0,
  std_amount_30d: 15000.0,
  pagerank: 0.15,
  clustering_coef: 0.35,
  time_since_last_txn: 3600,
  is_weekend: 0,
  hour_of_day: 12,
};

/**
 * Feature retrieval service for Redis
 * Includes circuit breaker for fault tolerance
 */
@injectable()
class FeatureService {
  private redisClient: Redis;
  private featureCircuitBreaker: CircuitBreaker<any[], any>;
  private readonly featureTimeout: number;
  private readonly featureDimensions = 434;

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
          return this.getDefaultFeatures();
        },
      }
    );
  }

  /**
   * Get features for a user with circuit breaker protection
   * @param senderId - The sender's user ID
   * @param timestamp - Transaction timestamp for time-based features
   * @returns Feature vector and metadata
   */
  async getFeatures(
    senderId: string,
    timestamp: number
  ): Promise<{ features: Float32Array; isDefault: boolean }> {
    const traceId = TraceContext.getTraceId();
    
    featureLogger.entry("getFeatures", "Fetching user features from Redis", {
      traceId,
      senderId,
      timestamp,
    });

    try {
      const userFeatures = await this.featureCircuitBreaker.fire(senderId);
      const isDefault = this.isDefaultFeatures(userFeatures);

      // Enrich with time-based features
      const enrichedFeatures = this.enrichWithTimeFeatures(userFeatures, timestamp);

      // Convert to Float32Array for ONNX
      const featureVector = this.toFeatureVector(enrichedFeatures);

      if (!isDefault) {
        metricsService.recordCacheHit();
        featureLogger.success("getFeatures", "Features retrieved from Redis cache", {
          traceId,
          senderId,
          featureCount: this.featureDimensions,
        });
      } else {
        metricsService.recordCacheMiss();
        featureLogger.debug("getFeatures", "Using default features (cache miss)", {
          traceId,
          senderId,
        });
      }

      return { features: featureVector, isDefault };
    } catch (err) {
      featureLogger.error("getFeatures", "Error retrieving features", {
        traceId,
        senderId,
        error: err instanceof Error ? err.message : String(err),
      });
      metricsService.recordCacheMiss();

      // Return default features on error
      const defaultFeatures = this.getDefaultFeatures();
      const enrichedFeatures = this.enrichWithTimeFeatures(defaultFeatures, timestamp);
      const featureVector = this.toFeatureVector(enrichedFeatures);

      return { features: featureVector, isDefault: true };
    }
  }

  /**
   * Fetch features from Redis
   */
  private async fetchFeaturesFromRedis(senderId: string): Promise<UserFeatures> {
    const key = `features:${senderId}`;
    const traceId = TraceContext.getTraceId();

    // Use HGETALL with timeout
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
      return this.getDefaultFeatures();
    }

    // Parse numeric values
    const parsedFeatures: UserFeatures = {} as UserFeatures;
    for (const [key, value] of Object.entries(features)) {
      parsedFeatures[key] = parseFloat(value) || 0;
    }

    return parsedFeatures;
  }

  /**
   * Get default features (population averages)
   */
  private getDefaultFeatures(): UserFeatures {
    return { ...DEFAULT_FEATURES };
  }

  /**
   * Check if features are default
   */
  private isDefaultFeatures(features: UserFeatures): boolean {
    return (
      features.velocity_1h === DEFAULT_FEATURES.velocity_1h &&
      features.velocity_24h === DEFAULT_FEATURES.velocity_24h
    );
  }

  /**
   * Enrich features with time-based calculations
   */
  private enrichWithTimeFeatures(features: UserFeatures, timestamp: number): UserFeatures {
    const date = new Date(timestamp);
    const dayOfWeek = date.getUTCDay();
    const hourOfDay = date.getUTCHours();

    return {
      ...features,
      is_weekend: dayOfWeek === 0 || dayOfWeek === 6 ? 1 : 0,
      hour_of_day: hourOfDay,
    };
  }

  /**
   * Convert features object to Float32Array for ONNX
   */
  private toFeatureVector(features: UserFeatures): Float32Array {
    const vector = new Float32Array(this.featureDimensions);

    // Map known features to their positions
    const featureOrder = [
      "velocity_1h",
      "velocity_24h",
      "velocity_7d",
      "avg_amount_30d",
      "std_amount_30d",
      "pagerank",
      "clustering_coef",
      "time_since_last_txn",
      "is_weekend",
      "hour_of_day",
    ];

    featureOrder.forEach((key, index) => {
      vector[index] = features[key] || 0;
    });

    // Fill remaining dimensions with derived features or zeros
    // In production, this would include all 434 engineered features
    for (let i = featureOrder.length; i < this.featureDimensions; i++) {
      vector[i] = 0;
    }

    return vector;
  }

  /**
   * Timeout promise helper
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Feature retrieval timeout (${ms}ms)`)), ms);
    });
  }

  /**
   * Check if Redis is connected
   */
  isReady(): boolean {
    return this.redisClient.status === "ready";
  }
}

export default FeatureService;
