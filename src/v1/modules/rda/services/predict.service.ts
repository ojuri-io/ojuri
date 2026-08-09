import { randomUUID } from "crypto";
import httpStatus from "http-status";
import { injectable } from "tsyringe";
import appConfig from "@config/app.config";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import OnnxService from "@shared/onnx/onnx.service";
import KafkaProducer, { TransactionEvent } from "@shared/kafka/kafka-producer";
import { AuditPipeline } from "@shared/enums/audit-pipeline.enum";
import DecisionPublishError from "@shared/error/decision-publish.error";
import { explain, ReasonCode } from "@shared/onnx/reason-codes";
import RulesService from "@shared/rules/rules.service";
import { RuleContext } from "@shared/rules/rule.types";
import ModelRegistryService from "@shared/models/model-registry.service";
import DecisionAuditService from "@shared/audit/decision-audit.service";
import { DecisionAuditRecord } from "@shared/audit/decision-audit.types";
import WebhookService from "@shared/webhooks/webhook.service";
import IdempotencyService from "@shared/idempotency/idempotency.service";
import { loadCatalog } from "@shared/features/feature-catalog";
import { buildFeatures } from "@shared/features/feature-builder";
import { Decision } from "@shared/enums/decision.enum";
import { WebhookEvent } from "@shared/enums/webhook-event.enum";
import { DecisionSource } from "@shared/enums/decision-source.enum";
import { RuleAction } from "@shared/enums/rule-action.enum";
import { RuleStage } from "@shared/enums/rule-stage.enum";
import DuplicateTransactionError from "@shared/error/duplicate-transaction.error";
import FeatureService from "./feature.service";
import { PredictRequestDto, PredictResponseDto } from "../dtos/predict-request.dto";
import { CalibrationMode } from "@shared/onnx/onnx.types";
import {
  FeaturesPayload,
  FinalVerdict,
  MlDecision,
  MlOutcome,
  ModelMeta,
  PredictDecisionContext,
  PredictInvocation,
  PredictOutcome,
  PredictRuleHit,
} from "./predict.types";
import DecisionAuditFactory from "../factories/decision-audit.factory";
import PredictDecisionContextFactory from "../factories/predict-decision-context.factory";
import PredictResponseFactory from "../factories/predict-response.factory";
import TransactionEventFactory from "../factories/transaction-event.factory";
import { ruleActionToDecision } from "../utils/rule-action-to-decision";
import { bandDecision } from "../utils/band-decision";
import { round4 } from "../utils/round";

const log = createServiceLogger("PredictService");

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000;
const DEFAULT_TENANT = "default";
const EMPTY_FEATURES: Record<string, number> = Object.freeze({});

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
    private idempotencyService: IdempotencyService,
  ) {}

  async executePrediction(invocation: PredictInvocation): Promise<PredictOutcome> {
    const startTime = Date.now();
    return invocation.idempotencyKey
      ? this.executeWithIdempotencyKey(invocation, startTime)
      : this.executeWithoutIdempotencyKey(invocation, startTime);
  }

  private async executeWithoutIdempotencyKey(
    invocation: PredictInvocation,
    startTime: number,
  ): Promise<PredictOutcome> {
    const tenantId = invocation.tenantId ?? DEFAULT_TENANT;
    const reserved = await this.idempotencyService.reserveTransactionId(
      tenantId,
      invocation.request.transaction_id,
    );
    if (!reserved) {
      return { kind: "duplicate", transactionId: invocation.request.transaction_id };
    }
    // A reservation held past a failed prediction burns the
    // transaction_id for the full idempotency TTL, so the client's retry
    // of a 5xx gets a 409 with no cached response to replay.
    return this.runAndWrap(invocation, startTime, () =>
      this.idempotencyService.releaseTransactionId(tenantId, invocation.request.transaction_id),
    );
  }

  private async executeWithIdempotencyKey(
    invocation: PredictInvocation,
    startTime: number,
  ): Promise<PredictOutcome> {
    const idemKey = {
      tenantId: invocation.tenantId ?? DEFAULT_TENANT,
      apiKeyId: invocation.apiKeyId ?? null,
      key: invocation.idempotencyKey as string,
    };
    const requestHash = IdempotencyService.hashRequest(invocation.request);

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
      const outcome = await this.runAndWrap(invocation, startTime);
      if (outcome.kind === "ok") {
        await this.idempotencyService.store({
          ...idemKey,
          requestHash,
          response: outcome.response as unknown as Record<string, unknown>,
          ttlMs: IDEMPOTENCY_TTL_MS,
        });
      }
      return outcome;
    } finally {
      await lock.release();
    }
  }

  private async runAndWrap(
    invocation: PredictInvocation,
    startTime: number,
    onFailure?: () => Promise<void>,
  ): Promise<PredictOutcome> {
    try {
      const response = await this.predict(invocation, startTime);
      const latencyMs = Date.now() - startTime;
      this.recordOk(latencyMs);
      return { kind: "ok", response, latencyMs };
    } catch (err) {
      if (err instanceof DuplicateTransactionError) {
        return { kind: "duplicate", transactionId: err.transactionId };
      }
      if (onFailure) {
        await onFailure().catch((e) =>
          log.warn("release", "Failed to release transaction reservation", { err: String(e) }),
        );
      }
      this.recordError();
      throw err;
    }
  }

  private async predict(
    invocation: PredictInvocation,
    startTime: number,
  ): Promise<PredictResponseDto> {
    const { request, tenantId } = invocation;
    let t0 = performance.now();
    const modelMeta = this.resolveModel(request.segment ?? request.transaction_type);
    metricsService.recordPredictStage("resolve_model", performance.now() - t0);

    // Every shipped PRE rule reads request fields only, so paying the
    // Redis feature read before them is pure latency on a request the
    // rules engine is about to decline outright.
    t0 = performance.now();
    const requestCtx = this.buildRuleContext(request, tenantId, EMPTY_FEATURES);
    const earlyHit = this.rulesService.evaluateRequestOnlyPre(requestCtx);
    metricsService.recordPredictStage("pre_rules_request_only", performance.now() - t0);

    if (this.isHardRuleDecision(earlyHit)) {
      const ctx = PredictDecisionContextFactory.fromPreRule({
        invocation,
        request,
        startTime,
        rule: earlyHit,
        finalDecision: ruleActionToDecision(earlyHit.rule.action),
        threshold: modelMeta.threshold,
        championVersion: modelMeta.championVersion,
        shadowVersion: modelMeta.shadowVersion,
        // null, not empty: the rule decided without ever loading
        // features, which is a different claim from "Redis missed, so we
        // scored on defaults". The audit row must not assert the latter.
        reasonCodes: null,
        featuresSnapshot: null,
        isDefault: false,
      });
      // The decision doesn't need features, but the audit trail does.
      // Load them behind the response and patch the queued row.
      return this.finalize(ctx, this.loadFeaturesForAudit(request));
    }

    t0 = performance.now();
    const features = await this.loadFeatures(request);
    metricsService.recordPredictStage("feature_load", performance.now() - t0);

    const ruleCtx: RuleContext = { ...requestCtx, features: features.snapshot };

    t0 = performance.now();
    const preHit = this.rulesService.evaluate(RuleStage.PRE, ruleCtx);
    metricsService.recordPredictStage("pre_rules", performance.now() - t0);

    if (this.isHardRuleDecision(preHit)) {
      const ctx = PredictDecisionContextFactory.fromPreRule({
        invocation,
        request,
        startTime,
        rule: preHit,
        finalDecision: ruleActionToDecision(preHit.rule.action),
        threshold: modelMeta.threshold,
        championVersion: modelMeta.championVersion,
        shadowVersion: modelMeta.shadowVersion,
        reasonCodes: explain(features.enrichedVector),
        featuresSnapshot: features.snapshot,
        isDefault: features.isDefault,
      });
      return this.finalize(ctx, null);
    }

    t0 = performance.now();
    const ml = await this.runInference(
      features.enrichedVector,
      modelMeta.threshold,
      modelMeta.reviewThreshold,
    );
    metricsService.recordPredictStage("inference", performance.now() - t0);

    // Observational only, so it never blocks the response: the score is
    // patched into the queued audit row if it lands before the flush.
    const shadowScorePromise = this.scoreShadow(modelMeta, features.enrichedVector);

    t0 = performance.now();
    const reasonCodes = explain(features.enrichedVector);
    metricsService.recordPredictStage("reason_codes", performance.now() - t0);

    t0 = performance.now();
    const verdict = this.evaluatePostRules(ruleCtx, ml);
    metricsService.recordPredictStage("post_rules", performance.now() - t0);

    const ctx = PredictDecisionContextFactory.fromMlDecision({
      invocation,
      request,
      startTime,
      postRule: verdict.postRule,
      finalDecision: verdict.finalDecision,
      decisionSource: verdict.decisionSource,
      mlScore: ml.score,
      calibratedScore: ml.calibratedScore,
      mlDecision: ml.decision,
      threshold: modelMeta.threshold,
      championVersion: modelMeta.championVersion,
      shadowVersion: modelMeta.shadowVersion,
      shadowScore: null,
      reasonCodes,
      featuresSnapshot: features.snapshot,
      isDefault: features.isDefault,
    });
    return this.finalize(
      ctx,
      shadowScorePromise ? shadowScorePromise.then((shadowScore) => ({ shadowScore })) : null,
    );
  }

  private scoreShadow(
    modelMeta: ModelMeta,
    vector: Float32Array,
  ): Promise<number | null> | null {
    if (!modelMeta.shadowVersion) return null;
    if (Math.random() >= appConfig.onnx.shadowSampleRate) return null;
    return this.onnxService.predictShadow(vector);
  }

  private resolveModel(segment?: string): ModelMeta {
    const { championVersion, shadowVersion, threshold, reviewThreshold } =
      this.modelRegistry.resolve(segment);
    return { championVersion, shadowVersion, threshold, reviewThreshold };
  }

  private async loadFeatures(request: PredictRequestDto): Promise<FeaturesPayload> {
    const catalog = loadCatalog();
    const { snapshot: redisSnapshot, isDefault } = await this.featureService.getFeatures(
      request.sender_id,
      request.receiver_id,
      request.timestamp,
    );
    const { vector, snapshot } = buildFeatures(
      catalog,
      request as unknown as Record<string, unknown>,
      redisSnapshot,
    );
    return { enrichedVector: vector, snapshot, isDefault };
  }

  private async runInference(
    vector: Float32Array,
    threshold: number,
    reviewThreshold: number | null,
  ): Promise<MlOutcome> {
    const outcome = await this.onnxService.predict(vector);

    // The breaker fallback means inference never ran. Declining on
    // infrastructure failure turns one contention spike into customer-
    // facing mass declines; routing to REVIEW keeps a human in the loop.
    if (outcome.degraded) {
      return {
        score: outcome.score,
        calibratedScore: null,
        decision: appConfig.circuitBreaker.onnx.fallbackDecision as MlDecision,
        degraded: true,
      };
    }

    // Thresholds were tuned against the raw score distribution; ENFORCE
    // is only correct once they have been re-derived from calibrated data.
    const decisionScore =
      appConfig.onnx.calibrationMode === CalibrationMode.ENFORCE && outcome.calibratedScore !== null
        ? outcome.calibratedScore
        : outcome.score;

    return {
      score: outcome.score,
      calibratedScore: outcome.calibratedScore,
      decision: bandDecision(decisionScore, threshold, reviewThreshold),
      degraded: false,
    };
  }

  private evaluatePostRules(baseCtx: RuleContext, ml: MlOutcome): FinalVerdict {
    const postCtx: RuleContext = { ...baseCtx, ml_score: ml.score, ml_decision: ml.decision };
    const postHit = this.rulesService.evaluate(RuleStage.POST, postCtx);

    if (this.isHardRuleDecision(postHit)) {
      return {
        postRule: postHit,
        finalDecision: ruleActionToDecision(postHit.rule.action),
        decisionSource: DecisionSource.POST_RULE,
      };
    }
    return {
      postRule: null,
      finalDecision: ml.decision,
      decisionSource: ml.degraded ? DecisionSource.BREAKER_FALLBACK : DecisionSource.ML,
    };
  }

  private isHardRuleDecision(
    hit: PredictRuleHit | null,
  ): hit is PredictRuleHit & { rule: { action: Exclude<RuleAction, RuleAction.NONE> } } {
    return hit !== null && hit.rule.action !== RuleAction.NONE;
  }

  private async finalize(
    ctx: PredictDecisionContext,
    lateAudit: Promise<Partial<DecisionAuditRecord>> | null,
  ): Promise<PredictResponseDto> {
    const latencyMs = Date.now() - ctx.startTime;
    metricsService.recordDecision(ctx.finalDecision);

    // Attach the handler now: persistAudit can throw, and an unhandled
    // rejection from an already-started promise would take the process
    // down. Redis failing and the audit queue backing up correlate.
    const late = lateAudit?.catch((err) => {
      log.warn("audit", "Late audit enrichment failed", { err: String(err) });
      return null;
    });

    const record = DecisionAuditFactory.createRecord(ctx, latencyMs);

    if (appConfig.audit.pipeline === AuditPipeline.STREAM) {
      return this.finalizeStream(ctx, record, late, latencyMs);
    }

    const t0 = performance.now();
    // Sync mode writes straight through, so there is no queued row left
    // to patch — the late fields have to land before the insert.
    if (appConfig.audit.syncWrite) {
      Object.assign(record, (late && (await late)) ?? {});
    }
    const auditId = await this.persistAudit(record);
    metricsService.recordPredictStage("audit_enqueue", performance.now() - t0);

    if (late && !appConfig.audit.syncWrite) {
      void late.then((fields) => fields && this.decisionAudit.patchLate(auditId, fields));
    }

    this.dispatchAsyncEffects(ctx, auditId);

    return PredictResponseFactory.create(ctx, auditId, latencyMs);
  }

  /**
   * Log-first pipeline: the event — carrying the full audit payload — is
   * the durable write, acked by the broker before the client hears the
   * decision. The audit table is materialised from the topic by
   * AuditStreamConsumer. Values that resolve after publication (shadow
   * scores, early-PRE feature snapshots) follow as an enrichment event
   * the consumer applies as an UPDATE.
   */
  private async finalizeStream(
    ctx: PredictDecisionContext,
    record: DecisionAuditRecord,
    late: Promise<Partial<DecisionAuditRecord> | null> | undefined,
    latencyMs: number,
  ): Promise<PredictResponseDto> {
    const auditId = randomUUID();
    const event = TransactionEventFactory.fromDecisionContext(ctx, auditId);
    event.audit = { ...record, auditId };

    const t0 = performance.now();
    try {
      await this.kafkaProducer.publishDurable(event);
    } catch (err) {
      log.error("kafka", "Durable decision publish failed", { err: String(err) });
      throw new DecisionPublishError(ctx.request.transaction_id);
    }
    metricsService.recordPredictStage("audit_publish", performance.now() - t0);

    if (late) {
      void late.then((fields) => {
        if (fields && Object.keys(fields).length > 0) {
          this.kafkaProducer.publishEnrichment({ audit_id: auditId, fields });
        }
      });
    }

    setImmediate(() => {
      this.publishBlockedEvent(ctx, event);
      this.publishDecisionWebhook(ctx, auditId);
    });

    return PredictResponseFactory.create(ctx, auditId, latencyMs);
  }

  private loadFeaturesForAudit(
    request: PredictRequestDto,
  ): Promise<Partial<DecisionAuditRecord>> {
    return this.loadFeatures(request).then((features) => ({
      featuresSnapshot: features.snapshot,
      featuresDefault: features.isDefault,
      reasonCodes: explain(features.enrichedVector),
    }));
  }

  private async persistAudit(record: DecisionAuditRecord): Promise<string> {
    if (!appConfig.audit.syncWrite) return this.decisionAudit.enqueue(record);
    return this.decisionAudit.recordDurable(record);
  }

  // Kafka publish + outbound webhook are off the response path. setImmediate
  // defers them past the response flush so the client doesn't wait on the
  // event-build CPU cost of a 35-field TransactionEvent.
  private dispatchAsyncEffects(ctx: PredictDecisionContext, auditId: string | null): void {
    setImmediate(() => {
      this.publishTransactionEvent(ctx, auditId);
      this.publishDecisionWebhook(ctx, auditId);
    });
  }

  private publishTransactionEvent(ctx: PredictDecisionContext, auditId: string | null): void {
    try {
      const event = TransactionEventFactory.fromDecisionContext(ctx, auditId);
      this.kafkaProducer.publishAsync(event);
      this.publishBlockedEvent(ctx, event);
    } catch (err) {
      log.error("kafka", "Deferred Kafka publish failed", { err: String(err) });
    }
  }

  // A breaker-fallback decline carries no model signal, so there is
  // nothing for FIA to investigate — and during an outage every
  // request would otherwise queue an LLM report.
  private publishBlockedEvent(ctx: PredictDecisionContext, event: TransactionEvent): void {
    try {
      const investigable =
        ctx.finalDecision === Decision.DECLINE &&
        ctx.decisionSource !== DecisionSource.BREAKER_FALLBACK;
      if (investigable) {
        this.kafkaProducer.publishAsync(event, appConfig.kafka.blockedTopic, event.transaction_id);
      }
    } catch (err) {
      log.error("kafka", "Blocked-topic publish failed", { err: String(err) });
    }
  }

  private publishDecisionWebhook(ctx: PredictDecisionContext, auditId: string | null): void {
    const { invocation, request, reasonCodes } = ctx;
    this.webhookService
      .publish(
        WebhookEvent.DECISION_CREATED,
        {
          transaction_id: request.transaction_id,
          sender_id: request.sender_id,
          receiver_id: request.receiver_id,
          amount: request.amount,
          decision: ctx.finalDecision,
          decision_source: ctx.decisionSource,
          model_version: ctx.championVersion,
          fraud_probability: round4(ctx.mlScore),
          reason_codes: reasonCodes as ReasonCode[],
          audit_id: auditId,
        },
        invocation.tenantId ?? undefined,
      )
      .catch((err) => log.error("webhook", "Failed to publish webhook", { err: String(err) }));
  }

  private buildRuleContext(
    request: PredictRequestDto,
    tenantId: string | null | undefined,
    features: Record<string, number>,
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
      ip_country: request.ip_country,
      transaction_country: request.transaction_country,
      destination_country: request.destination_country,
      ip_is_vpn: request.ip_is_vpn,
      device_is_trusted: request.device_is_trusted,
      is_authenticated: request.is_authenticated,
      session_to_txn_seconds: request.session_to_txn_seconds,
      account_age_days: request.account_age_days,
      channel: request.channel,
      currency: request.currency,
      features,
    };
  }

  private recordOk(latencyMs: number): void {
    metricsService.recordRequest("POST", "/predict", httpStatus.OK);
    metricsService.recordLatency("POST", "/predict", latencyMs);
  }

  private recordError(): void {
    metricsService.recordRequest("POST", "/predict", httpStatus.INTERNAL_SERVER_ERROR);
    metricsService.recordError("request_error");
  }

  isReady(): boolean {
    return this.featureService.isReady() && this.onnxService.isReady();
  }
}

export default PredictService;
