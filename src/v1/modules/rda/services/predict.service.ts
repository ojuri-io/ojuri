import { injectable } from "tsyringe";
import appConfig from "@config/app.config";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import OnnxService from "@shared/onnx/onnx.service";
import KafkaProducer, { TransactionEvent } from "@shared/kafka/kafka-producer";
import { explain, ReasonCode } from "@shared/onnx/reason-codes";
import RulesService from "@shared/rules/rules.service";
import { RuleContext } from "@shared/rules/rule.types";
import ModelRegistryService from "@shared/models/model-registry.service";
import DecisionAuditService from "@shared/audit/decision-audit.service";
import WebhookService from "@shared/webhooks/webhook.service";
import FeatureService from "./feature.service";
import { PredictRequestDto, PredictResponseDto } from "../dtos/predict-request.dto";

const log = createServiceLogger("PredictService");

export interface PredictInvocation {
  request: PredictRequestDto;
  traceId: string;
  tenantId?: string | null;
  apiKeyId?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Fraud prediction service
 * Orchestrates feature retrieval, rule evaluation, ML inference,
 * audit logging, and event publishing.
 */
@injectable()
class PredictService {
  constructor(
    private featureService: FeatureService,
    private onnxService: OnnxService,
    private kafkaProducer: KafkaProducer,
    private rulesService: RulesService,
    private modelRegistry: ModelRegistryService,
    private decisionAudit: DecisionAuditService,
    private webhookService: WebhookService
  ) {}

  async predict(invocation: PredictInvocation): Promise<PredictResponseDto> {
    const { request, tenantId } = invocation;
    const startTime = Date.now();

    log.entry("predict", "Starting fraud prediction pipeline", {
      transactionId: request.transaction_id,
      senderId: request.sender_id,
      amount: request.amount,
    });

    const { championVersion, shadowVersion, threshold } = this.modelRegistry.resolve(request.segment);

    // Step 1: Pull features. The pre-rule path also needs these
    // because rules can reference feature values.
    const { features, isDefault } = await this.featureService.getFeatures(
      request.sender_id,
      request.timestamp
    );

    const enrichedFeatures = this.enrichFeatures(features, request);
    const featuresSnapshot = this.snapshotFeatures(enrichedFeatures);

    // Step 2: Evaluate PRE-stage rules. A match short-circuits the
    // pipeline — useful for allowlists, blocklists, or hard caps
    // that should never reach the model.
    const preCtx = this.buildRuleContext(request, tenantId, featuresSnapshot);
    const preHit = this.rulesService.evaluate("PRE", preCtx);

    if (preHit && preHit.rule.action !== "NONE") {
      const finalDecision = preHit.rule.action === "ALLOW" ? "ACCEPT" : preHit.rule.action === "DENY" ? "DECLINE" : "REVIEW";
      const reasonCodes = explain(enrichedFeatures);
      return this.finalize({
        invocation,
        startTime,
        request,
        finalDecision,
        decisionSource: "PRE_RULE",
        rule: preHit,
        mlScore: 0,
        mlDecision: "ACCEPT",
        threshold,
        championVersion,
        shadowVersion,
        reasonCodes,
        featuresSnapshot,
        isDefault,
      });
    }

    // Step 3: ML inference.
    const fraudProbability = await this.onnxService.predict(enrichedFeatures);
    const mlFraud = fraudProbability >= threshold;
    const mlDecision: "ACCEPT" | "DECLINE" = mlFraud ? "DECLINE" : "ACCEPT";
    const reasonCodes = explain(enrichedFeatures);

    // Step 4: POST-stage rules can override the model.
    const postCtx: RuleContext = { ...preCtx, ml_score: fraudProbability, ml_decision: mlDecision };
    const postHit = this.rulesService.evaluate("POST", postCtx);

    let finalDecision: "ACCEPT" | "DECLINE" | "REVIEW" = mlDecision;
    let decisionSource: "ML" | "PRE_RULE" | "POST_RULE" = "ML";

    if (postHit && postHit.rule.action !== "NONE") {
      finalDecision = postHit.rule.action === "ALLOW" ? "ACCEPT" : postHit.rule.action === "DENY" ? "DECLINE" : "REVIEW";
      decisionSource = "POST_RULE";
    }

    return this.finalize({
      invocation,
      startTime,
      request,
      finalDecision,
      decisionSource,
      rule: postHit,
      mlScore: fraudProbability,
      mlDecision,
      threshold,
      championVersion,
      shadowVersion,
      reasonCodes,
      featuresSnapshot,
      isDefault,
    });
  }

  private async finalize(args: {
    invocation: PredictInvocation;
    startTime: number;
    request: PredictRequestDto;
    finalDecision: "ACCEPT" | "DECLINE" | "REVIEW";
    decisionSource: "ML" | "PRE_RULE" | "POST_RULE";
    rule: { rule: { id: string; name: string }; stage: "PRE" | "POST" } | null;
    mlScore: number;
    mlDecision: "ACCEPT" | "DECLINE";
    threshold: number;
    championVersion: string;
    shadowVersion: string | null;
    reasonCodes: ReasonCode[];
    featuresSnapshot: Record<string, number>;
    isDefault: boolean;
  }): Promise<PredictResponseDto> {
    const { invocation, request } = args;
    const latencyMs = Date.now() - args.startTime;

    metricsService.recordDecision(args.finalDecision);

    const auditId = await this.decisionAudit.record({
      transactionId: request.transaction_id,
      tenantId: invocation.tenantId ?? null,
      apiKeyId: invocation.apiKeyId ?? null,
      correlationId: invocation.traceId,
      idempotencyKey: invocation.idempotencyKey ?? null,

      senderId: request.sender_id,
      receiverId: request.receiver_id,
      amount: request.amount,
      transactionType: request.transaction_type,
      segment: request.segment ?? null,

      championModelVersion: args.championVersion,
      shadowModelVersion: args.shadowVersion,
      championScore: args.mlScore,
      shadowScore: null,
      threshold: args.threshold,

      mlDecision: args.mlDecision,
      finalDecision: args.finalDecision,
      decisionSource: args.decisionSource,

      ruleId: args.rule?.rule.id ?? null,
      ruleName: args.rule?.rule.name ?? null,
      ruleStage: args.rule?.stage ?? null,

      reasonCodes: args.reasonCodes,
      featuresSnapshot: args.featuresSnapshot,
      featuresDefault: args.isDefault,

      latencyMs,
    });

    // Publish to Kafka (existing behaviour). Treat REVIEW as a
    // non-blocked outcome at the auth path — downstream consumers
    // can split on `decision` if they care.
    this.publishTransactionEvent(
      request,
      args.finalDecision === "DECLINE",
      args.mlScore,
      args.finalDecision
    );

    // Webhook fan-out (fire-and-forget).
    this.webhookService
      .publish(
        "decision.created",
        {
          transaction_id: request.transaction_id,
          sender_id: request.sender_id,
          receiver_id: request.receiver_id,
          amount: request.amount,
          decision: args.finalDecision,
          decision_source: args.decisionSource,
          model_version: args.championVersion,
          fraud_probability: round4(args.mlScore),
          reason_codes: args.reasonCodes,
          audit_id: auditId,
        },
        invocation.tenantId ?? undefined
      )
      .catch((err) => log.error("webhook", "Failed to publish webhook", { err: String(err) }));

    return {
      transaction_id: request.transaction_id,
      fraud: args.finalDecision === "DECLINE",
      fraud_probability: round4(args.mlScore),
      decision: args.finalDecision,
      decision_source: args.decisionSource,
      reason_codes: args.reasonCodes,
      model_version: args.championVersion,
      threshold: args.threshold,
      rule: args.rule
        ? { id: args.rule.rule.id, name: args.rule.rule.name, stage: args.rule.stage }
        : undefined,
      audit_id: auditId ?? undefined,
      latency_ms: latencyMs,
      timestamp: Date.now(),
    };
  }

  private buildRuleContext(
    request: PredictRequestDto,
    tenantId: string | null | undefined,
    features: Record<string, number>
  ): RuleContext {
    return {
      transaction_id: request.transaction_id,
      sender_id: request.sender_id,
      receiver_id: request.receiver_id,
      amount: request.amount,
      transaction_type: request.transaction_type,
      timestamp: request.timestamp,
      segment: request.segment,
      tenant_id: tenantId ?? undefined,
      features,
    };
  }

  /**
   * Snapshot the named feature positions so they can be referenced
   * by name in rule expressions and persisted alongside the
   * decision in the audit log.
   */
  private snapshotFeatures(enriched: Float32Array): Record<string, number> {
    return {
      velocity_1h: enriched[0],
      velocity_24h: enriched[1],
      velocity_7d: enriched[2],
      avg_amount_30d: enriched[3],
      std_amount_30d: enriched[4],
      pagerank: enriched[5],
      clustering_coef: enriched[6],
      time_since_last_txn: enriched[7],
      is_weekend: enriched[8],
      hour_of_day: enriched[9],
      amount: enriched[10],
      transaction_type_code: enriched[11],
    };
  }

  /**
   * Feature positions for transaction-specific enrichment
   * Positions 0-9: User features from Redis (velocity, graph metrics, time features)
   * Positions 10+: Transaction-specific features added at inference time
   */
  private static readonly FEATURE_POSITIONS = {
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

  private enrichFeatures(features: Float32Array, request: PredictRequestDto): Float32Array {
    const enriched = new Float32Array(features);
    enriched[PredictService.FEATURE_POSITIONS.AMOUNT] = request.amount;
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

    this.kafkaProducer.publishAsync(event);

    if (decision === "DECLINE") {
      this.kafkaProducer.publishAsync(event, appConfig.kafka.blockedTopic, event.transaction_id);
    }
  }

  isReady(): boolean {
    return this.featureService.isReady() && this.onnxService.isReady();
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export default PredictService;
