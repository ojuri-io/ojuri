import { injectable } from "tsyringe";
import appConfig from "@config/app.config";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import OnnxService from "@shared/onnx/onnx.service";
import KafkaProducer, { TransactionEvent } from "@shared/kafka/kafka-producer";
import FeatureService from "./feature.service";
import { PredictRequestDto, PredictResponseDto } from "../dtos/predict-request.dto";

const log = createServiceLogger("PredictService");

/**
 * Fraud prediction service
 * Orchestrates feature retrieval, model inference, and event publishing
 */
@injectable()
class PredictService {
  constructor(
    private featureService: FeatureService,
    private onnxService: OnnxService,
    private kafkaProducer: KafkaProducer
  ) {}

  /**
   * Process a fraud prediction request
   * @param request - Transaction details
   * @param traceId - Request trace ID for tracing
   * @returns Fraud prediction response
   */
  async predict(request: PredictRequestDto, traceId: string): Promise<PredictResponseDto> {
    const startTime = Date.now();

    log.entry("predict", "Starting fraud prediction pipeline", {
      transactionId: request.transaction_id,
      senderId: request.sender_id,
      amount: request.amount,
    });

    try {
      // Step 1: Retrieve features from Redis (with circuit breaker)
      log.debug("predict", "Fetching features from Redis cache", {
        senderId: request.sender_id,
      });

      const { features, isDefault } = await this.featureService.getFeatures(
        request.sender_id,
        request.timestamp
      );

      if (isDefault) {
        log.warn("predict", "Using default features - Redis cache miss, degraded accuracy expected", {
          senderId: request.sender_id,
        });
      } else {
        log.debug("predict", "Features retrieved from cache", {
          senderId: request.sender_id,
          featureCount: features.length,
        });
      }

      // Step 2: Enrich features with transaction-specific data
      log.debug("predict", "Enriching features with transaction-specific data");
      const enrichedFeatures = this.enrichFeatures(features, request);

      // Step 3: Run ONNX model inference (with circuit breaker)
      log.debug("predict", "Executing ONNX model prediction");
      const fraudProbability = await this.onnxService.predict(enrichedFeatures);

      // Step 4: Make decision based on threshold
      const fraud = fraudProbability >= appConfig.fraud.threshold;
      const decision: "ACCEPT" | "DECLINE" = fraud ? "DECLINE" : "ACCEPT";

      log.info("predict", `Prediction computed - Decision: ${decision}`, {
        fraudProbability: Math.round(fraudProbability * 10000) / 10000,
        threshold: appConfig.fraud.threshold,
        fraud,
        decision,
      });

      // Record metrics
      metricsService.recordDecision(decision);

      const latencyMs = Date.now() - startTime;

      // Step 5: Publish event to Kafka asynchronously (fire-and-forget)
      log.debug("predict", "Publishing event to Kafka topic", {
        topic: appConfig.kafka.topic,
      });
      this.publishTransactionEvent(request, fraud, fraudProbability, decision);

      const response: PredictResponseDto = {
        transaction_id: request.transaction_id,
        fraud,
        fraud_probability: Math.round(fraudProbability * 10000) / 10000, // 4 decimal places
        decision,
        latency_ms: latencyMs,
        timestamp: Date.now(),
      };

      log.exit("predict", "Prediction pipeline completed", {
        transactionId: request.transaction_id,
        latencyMs,
      });

      return response;
    } catch (err) {
      log.error("predict", "Prediction pipeline failed", {
        transactionId: request.transaction_id,
        latencyMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      });

      metricsService.recordError("prediction_error");
      throw err;
    }
  }

  /**
   * Feature positions for transaction-specific enrichment
   * Positions 0-9: User features from Redis (velocity, graph metrics, time features)
   * Positions 10+: Transaction-specific features added at inference time
   */
  private static readonly FEATURE_POSITIONS = {
    // Transaction-specific features (added during enrichment)
    AMOUNT: 10,
    TRANSACTION_TYPE: 11,
  } as const;

  private static readonly TRANSACTION_TYPE_ENCODING: Record<string, number> = {
    CASH_IN: 0,
    CASH_OUT: 1,
    PAYMENT: 2,
    TRANSFER: 3,
    DEBIT: 4,
  };

  /**
   * Enrich feature vector with transaction-specific data
   * User features (positions 0-9) come from Redis via FeatureService
   * Transaction features (positions 10+) are added here at inference time
   */
  private enrichFeatures(features: Float32Array, request: PredictRequestDto): Float32Array {
    // Create a copy to avoid modifying the original
    const enriched = new Float32Array(features);

    // Add transaction amount (position 10)
    enriched[PredictService.FEATURE_POSITIONS.AMOUNT] = request.amount;

    // Add transaction type encoding (position 11)
    enriched[PredictService.FEATURE_POSITIONS.TRANSACTION_TYPE] =
      PredictService.TRANSACTION_TYPE_ENCODING[request.transaction_type] ?? 0;

    return enriched;
  }

  /**
   * Publish transaction event to Kafka asynchronously
   * Uses fire-and-forget pattern to not impact response latency.
   *
   * Always publishes to the primary `transactions.completed` topic (consumed
   * by PAA + MLA). When the model decision is DECLINE, additionally publishes
   * to `transactions.blocked` so the Fraud Investigation Agent (FIA) can
   * generate an investigation report. Both publishes are fire-and-forget so
   * authorization latency is unaffected.
   */
  private publishTransactionEvent(
    request: PredictRequestDto,
    fraud: boolean,
    fraudProbability: number,
    decision: string
  ): void {
    const event: TransactionEvent = {
      transaction_id: request.transaction_id,
      sender_id: request.sender_id,
      receiver_id: request.receiver_id,
      amount: request.amount,
      transaction_type: request.transaction_type,
      timestamp: request.timestamp,
      fraud,
      fraud_probability: fraudProbability,
      decision,
      device_fingerprint: request.device_fingerprint,
      processed_at: Date.now(),
    };

    // Fire-and-forget - don't await.
    // Primary topic keyed by sender_id so PAA preserves per-user ordering.
    this.kafkaProducer.publishAsync(event);

    // Blocked topic does NOT need per-user ordering (each report is independent),
    // and a single attacking sender would otherwise create a hot partition that
    // pins all FIA work to one consumer instance. Key by transaction_id so the
    // load spreads evenly across partitions and FIA can scale linearly.
    if (decision === "DECLINE") {
      this.kafkaProducer.publishAsync(
        event,
        appConfig.kafka.blockedTopic,
        event.transaction_id
      );
    }
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.featureService.isReady() && this.onnxService.isReady();
  }
}

export default PredictService;
