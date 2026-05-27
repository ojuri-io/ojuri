import httpStatus from "http-status";
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
import IdempotencyService from "@shared/idempotency/idempotency.service";
import { loadCatalog } from "@shared/features/feature-catalog";
import { buildFeatures } from "@shared/features/feature-builder";
import FeatureService from "./feature.service";
import { PredictRequestDto, PredictResponseDto } from "../dtos/predict-request.dto";

const log = createServiceLogger("PredictService");

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000;

export interface PredictInvocation {
  request: PredictRequestDto;
  traceId: string;
  tenantId?: string | null;
  apiKeyId?: string | null;
  idempotencyKey?: string | null;
}

export type PredictOutcome =
  | { kind: "ok"; response: PredictResponseDto; latencyMs: number }
  | { kind: "replay"; response: Record<string, unknown> }
  | { kind: "conflict" }
  | { kind: "in_flight" };

@injectable()
class PredictService {
  constructor(
    private featureService: FeatureService,
    private onnxService: OnnxService,
    private kafkaProducer: KafkaProducer,
    private rulesService: RulesService,
    private modelRegistry: ModelRegistryService,
    private decisionAudit: DecisionAuditService,
    private webhookService: WebhookService,
    private idempotencyService: IdempotencyService
  ) {}

  /**
   * End-to-end request handler: idempotency lookup, distributed lock,
   * inference, response cache, metrics. The HTTP layer just maps the
   * returned discriminator to a status code.
   */
  async executePrediction(invocation: PredictInvocation): Promise<PredictOutcome> {
    const startTime = Date.now();
    const { idempotencyKey, tenantId, apiKeyId, request } = invocation;

    if (!idempotencyKey) {
      const response = await this.predict(invocation);
      const latencyMs = Date.now() - startTime;
      this.recordOk(latencyMs);
      return { kind: "ok", response, latencyMs };
    }

    const idemKey = {
      tenantId: tenantId ?? "default",
      apiKeyId: apiKeyId ?? null,
      key: idempotencyKey,
    };
    const requestHash = IdempotencyService.hashRequest(request);

    const cached = await this.idempotencyService.lookup({ ...idemKey, requestHash });
    if (cached.kind === "replay") return { kind: "replay", response: cached.response };
    if (cached.kind === "conflict") return { kind: "conflict" };

    const lock = await this.idempotencyService.acquireLock(idemKey);
    if (!lock) {
      const waited = await this.idempotencyService.waitForReplay({ ...idemKey, requestHash });
      if (waited.kind === "replay") return { kind: "replay", response: waited.response };
      if (waited.kind === "conflict") return { kind: "conflict" };
      return { kind: "in_flight" };
    }

    try {
      const response = await this.predict(invocation);
      await this.idempotencyService.store({
        ...idemKey,
        requestHash,
        response: response as unknown as Record<string, unknown>,
        ttlMs: IDEMPOTENCY_TTL_MS,
      });
      const latencyMs = Date.now() - startTime;
      this.recordOk(latencyMs);
      return { kind: "ok", response, latencyMs };
    } catch (err) {
      this.recordError();
      throw err;
    } finally {
      await lock.release();
    }
  }

  private recordOk(latencyMs: number): void {
    metricsService.recordRequest("POST", "/predict", httpStatus.OK);
    metricsService.recordLatency("POST", "/predict", latencyMs);
  }

  private recordError(): void {
    metricsService.recordRequest("POST", "/predict", httpStatus.INTERNAL_SERVER_ERROR);
    metricsService.recordError("request_error");
  }

  async predict(invocation: PredictInvocation): Promise<PredictResponseDto> {
    const { request, tenantId } = invocation;
    const startTime = Date.now();

    log.entry("predict", "Starting fraud prediction pipeline", {
      transactionId: request.transaction_id,
      senderId: request.sender_id,
      amount: request.amount,
    });

    const { championVersion, shadowVersion, threshold } = this.modelRegistry.resolve(request.segment);

    // Step 1: Pull the Redis feature snapshot + build the catalogue-
    // aligned input vector. The catalogue is the single source of
    // truth for the ONNX input contract — feature.service.ts just
    // fetches the raw hash, and `buildFeatures` lays it out plus the
    // request-derived features in catalogue order.
    const catalog = loadCatalog();
    const { snapshot: redisSnapshot, isDefault } = await this.featureService.getFeatures(
      request.sender_id,
      request.timestamp
    );

    const { vector: enrichedFeatures, snapshot: featuresSnapshot } = buildFeatures(
      catalog,
      request as unknown as Record<string, unknown>,
      redisSnapshot
    );

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
    // can split on `decision` if they care. Include decision_source
    // and rule_name so FIA can distinguish "ML said fraud" from
    // "rule said fraud" — its fallback report classifier needs this
    // to avoid mislabelling rule-driven DECLINEs as LIKELY_LEGITIMATE.
    this.publishTransactionEvent(
      request,
      args.finalDecision === "DECLINE",
      args.mlScore,
      args.finalDecision,
      args.decisionSource,
      args.rule?.rule.name ?? null,
      auditId ?? null
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

  // NOTE — `snapshotFeatures()`, `FEATURE_POSITIONS`, the hand-rolled
  // `TRANSACTION_TYPE_ENCODING` table, and `enrichFeatures()` were
  // retired in Phase 2. All three are now subsumed by the feature
  // catalogue: `buildFeatures()` produces a vector AND a named
  // snapshot in one pass, and the catalogue's own encoders cover the
  // CASH_IN/OUT/etc. ID mapping (with a wider domain too — see
  // `src/shared/features/encoders.ts`).

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
    decision: string,
    decisionSource?: string,
    ruleName?: string | null,
    auditId?: string | null
  ): void {
    // Promote every DTO field PAA needs to persist to `transactions`.
    // Empty values pass through as undefined so the PAA writer maps
    // them to NULL — the loader will fall back to the catalogue
    // default for any feature whose column is NULL.
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
      decision_source: decisionSource,
      rule_name: ruleName ?? undefined,
      audit_id: auditId ?? undefined,
      device_fingerprint: request.device_fingerprint,
      processed_at: Date.now(),

      // Identity
      customer_dob: request.customer_dob,
      customer_nationality: request.customer_nationality,
      customer_type: request.customer_type,
      customer_id_type: request.customer_id_type,
      account_age_days: request.account_age_days,
      is_authenticated: request.is_authenticated,

      // Channel / currency
      channel: request.channel,
      currency: request.currency,
      is_inflow: request.is_inflow,
      is_recurring: request.is_recurring,

      // Wallet
      wallet_balance: request.wallet_balance,

      // Geographic
      customer_latitude: request.customer_latitude,
      customer_longitude: request.customer_longitude,
      transaction_country: request.transaction_country,
      destination_country: request.destination_country,
      ip_country: request.ip_country,
      transaction_lat: request.transaction_lat,
      transaction_lng: request.transaction_lng,

      // Device / session
      ip_is_vpn: request.ip_is_vpn,
      device_is_trusted: request.device_is_trusted,
      device_type: request.device_type,
      session_to_txn_seconds: request.session_to_txn_seconds,

      // Agent (only presence flag — lat/lng/battery are not persisted)
      agent_id: request.agent_id,

      // Receiver (no recipient_dob — minimal sender-side fraud signal)
      recipient_nationality: request.recipient_nationality,
      recipient_id_type: request.recipient_id_type,
      customer_fi: request.customer_fi,
      recipient_fi: request.recipient_fi,

      // Adopter overflow (read by the custom-feature hook on both sides)
      request_context: (request as unknown as Record<string, unknown>).request_context as
        | Record<string, unknown>
        | undefined,
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
