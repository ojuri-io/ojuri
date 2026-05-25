import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import { randomUUID } from "crypto";
import PredictService from "../services/predict.service";
import { PredictRequestDto } from "../dtos/predict-request.dto";
import IdempotencyService, { IDEMPOTENCY_KEY_MAX_LENGTH } from "@shared/idempotency/idempotency.service";
import DecisionAuditService from "@shared/audit/decision-audit.service";
import WebhookService from "@shared/webhooks/webhook.service";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import { metricsService } from "@shared/metrics/metrics.service";
import { createServiceLogger, TraceContext } from "@shared/utils/logger/service-logger";

const log = createServiceLogger("PredictController");

const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS) || 24 * 60 * 60 * 1000;

@injectable()
class PredictController {
  constructor(
    private predictService: PredictService,
    private idempotencyService: IdempotencyService,
    private decisionAudit: DecisionAuditService,
    private webhookService: WebhookService
  ) {}

  predict = async (
    req: FastifyRequest<{ Body: PredictRequestDto }>,
    res: FastifyReply
  ): Promise<void> => {
    const startTime = Date.now();
    const traceId = `req-${(req.headers["x-correlation-id"] as string) || randomUUID()}`;
    const request = req.body;
    const apiKey = req.apiKey;
    // tenantId is taken from the verified API key first, then from a JWT
    // subject if present, then defaults to "default". X-Tenant-ID is
    // *only* honored as a hint when a verified credential is present —
    // otherwise an unauthenticated caller could scope into another
    // tenant's namespace by setting the header.
    const headerTenant = req.headers["x-tenant-id"] as string | undefined;
    const tenantId =
      apiKey?.tenantId ??
      req.auth?.tenantId ??
      ((apiKey || req.auth) && headerTenant) ??
      "default";
    const rawIdempotency = (req.headers["idempotency-key"] as string | undefined) || null;
    // Cap key length so an attacker can't bloat the idempotencyKeys
    // table (or trigger an outsized hash) by spamming multi-MB headers.
    if (rawIdempotency && rawIdempotency.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      return res
        .code(httpStatus.BAD_REQUEST)
        .send(ErrorResponse(`Idempotency-Key must be ${IDEMPOTENCY_KEY_MAX_LENGTH} characters or fewer`));
    }
    const idempotencyKey = rawIdempotency;

    return TraceContext.runAsync(
      { traceId, transactionId: request.transaction_id, senderId: request.sender_id },
      async () => {
        log.entry("predict", "Processing fraud prediction request", {
          transactionId: request.transaction_id,
          senderId: request.sender_id,
          receiverId: request.receiver_id,
          amount: request.amount,
          transactionType: request.transaction_type,
          tenantId,
          apiKeyId: apiKey?.id,
        });

        // Idempotency replay path. Scoped by (tenantId, key) so adopters
        // who do partition by tenant still get isolation; single-tenant
        // deployments share the "default" namespace, which is fine.
        if (idempotencyKey) {
          const requestHash = IdempotencyService.hashRequest(request);
          const outcome = await this.idempotencyService.lookup({
            tenantId,
            apiKeyId: apiKey?.id ?? null,
            key: idempotencyKey,
            requestHash,
          });
          if (outcome.kind === "replay") {
            log.info("predict", "Idempotent replay served from cache", {
              transactionId: request.transaction_id,
              tenantId,
            });
            return res
              .code(httpStatus.OK)
              .header("X-Correlation-ID", traceId)
              .header("Idempotency-Replay", "true")
              .send(outcome.response);
          }
          if (outcome.kind === "conflict") {
            return res
              .code(httpStatus.UNPROCESSABLE_ENTITY)
              .header("X-Correlation-ID", traceId)
              .send(ErrorResponse("Idempotency-Key reused with a different request body"));
          }
        }

        try {
          const response = await this.predictService.predict({
            request,
            traceId,
            tenantId,
            apiKeyId: apiKey?.id ?? null,
            idempotencyKey,
          });

          const latencyMs = Date.now() - startTime;
          metricsService.recordRequest("POST", "/predict", httpStatus.OK);
          metricsService.recordLatency("POST", "/predict", latencyMs);

          if (idempotencyKey) {
            await this.idempotencyService.store({
              tenantId,
              apiKeyId: apiKey?.id ?? null,
              key: idempotencyKey,
              requestHash: IdempotencyService.hashRequest(request),
              response: response as unknown as Record<string, unknown>,
              ttlMs: IDEMPOTENCY_TTL_MS,
            });
          }

          log.success("predict", "Fraud prediction completed", {
            transactionId: response.transaction_id,
            fraud: response.fraud,
            fraudProbability: response.fraud_probability,
            decision: response.decision,
            decisionSource: response.decision_source,
            latencyMs,
          });

          res
            .code(httpStatus.OK)
            .header("X-Correlation-ID", traceId)
            .header("X-Response-Time", `${latencyMs}ms`)
            .send(response);
        } catch (err) {
          const latencyMs = Date.now() - startTime;

          log.error("predict", "Failed to process prediction request", {
            transactionId: request.transaction_id,
            latencyMs,
            error: err instanceof Error ? err.message : String(err),
          });

          metricsService.recordRequest("POST", "/predict", httpStatus.INTERNAL_SERVER_ERROR);
          metricsService.recordError("request_error");

          res
            .code(httpStatus.INTERNAL_SERVER_ERROR)
            .header("X-Correlation-ID", traceId)
            .send(ErrorResponse("Failed to process prediction request"));
        }
      }
    );
  };

  /**
   * Read a single audit row by transaction id. Useful for client
   * polling or for case-management UIs that pivot off the original
   * transaction id rather than the audit row's own id.
   */
  getDecision = async (req: FastifyRequest<{ Params: { transactionId: string } }>, res: FastifyReply) => {
    const row = await this.decisionAudit.getByTransactionId(req.params.transactionId);
    if (!row) {
      return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Decision not found"));
    }
    return res.send(SuccessResponse("Decision retrieved", row));
  };

  /**
   * Apply a human reviewer override. Persists the override on the
   * audit row and fires `decision.overridden` to subscribers.
   * The reviewer identity comes from the authenticated subject — the
   * body cannot forge it (audit-log integrity guarantee in SECURITY.md).
   */
  overrideDecision = async (
    req: FastifyRequest<{
      Params: { auditId: string };
      Body: { decision: "ACCEPT" | "DECLINE"; reason?: string };
    }>,
    res: FastifyReply
  ) => {
    const { auditId } = req.params;
    const { decision, reason } = req.body;

    if (decision !== "ACCEPT" && decision !== "DECLINE") {
      return res
        .code(httpStatus.BAD_REQUEST)
        .send(ErrorResponse("decision must be ACCEPT or DECLINE"));
    }

    const reviewer = req.auth?.username ?? null;
    if (!reviewer) {
      return res
        .code(httpStatus.UNAUTHORIZED)
        .send(ErrorResponse("Authenticated reviewer required for overrides"));
    }

    const row = await this.decisionAudit.override({ auditId, decision, reviewer, reason });
    if (!row) {
      return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Audit row not found"));
    }

    this.webhookService
      .publish(
        "decision.overridden",
        {
          audit_id: auditId,
          transaction_id: row.transactionId,
          original_decision: row.finalDecision,
          override_decision: decision,
          reviewer,
          reason,
        },
        row.tenantId ?? undefined
      )
      .catch((err) => log.error("override", "Webhook publish failed", { err: String(err) }));

    return res.send(SuccessResponse("Decision overridden", row));
  };

  reviewQueue = async (
    req: FastifyRequest<{
      Querystring: { limit?: string; offset?: string; order?: string; search?: string };
    }>,
    res: FastifyReply
  ) => {
    const limit = Number.parseInt(req.query.limit || "25", 10) || 25;
    const offset = Number.parseInt(req.query.offset || "0", 10) || 0;
    const order = req.query.order === "oldest" ? "oldest" : "newest";
    const search = req.query.search?.trim() || undefined;
    const { rows, total } = await this.decisionAudit.listReviewQueuePaginated({
      limit,
      offset,
      order,
      search,
    });
    return res.send(
      SuccessResponse("Review queue", { rows, total, limit, offset })
    );
  };

  /**
   * Recent decisions, newest-first, optionally bounded by `since`.
   * Powers the Live decisions page's polling feed. We cap `limit` at
   * 200 so a misconfigured client can't pull the whole table.
   */
  recentDecisions = async (
    req: FastifyRequest<{ Querystring: { since?: string; limit?: string } }>,
    res: FastifyReply
  ) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || "50", 10) || 50, 1), 200);
    const since = req.query.since ? new Date(req.query.since) : null;
    const rows = await this.decisionAudit.listRecentSince(since, limit);
    return res.send(SuccessResponse("Recent decisions", rows));
  };

  /**
   * Audit rows that share sender or receiver with the supplied audit
   * row. Powers the "Similar cases" panel on the Review queue.
   */
  similarDecisions = async (
    req: FastifyRequest<{ Params: { auditId: string }; Querystring: { limit?: string } }>,
    res: FastifyReply
  ) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit || "5", 10) || 5, 1), 20);
    const rows = await this.decisionAudit.listSimilar(req.params.auditId, limit);
    return res.send(SuccessResponse("Similar decisions", rows));
  };

  getMetrics = async (_req: FastifyRequest, res: FastifyReply): Promise<void> => {
    try {
      const metrics = await metricsService.getMetrics();
      res.code(httpStatus.OK).header("Content-Type", metricsService.getContentType()).send(metrics);
    } catch (err) {
      log.error("getMetrics", "Failed to get metrics", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.code(httpStatus.INTERNAL_SERVER_ERROR).send(ErrorResponse("Failed to get metrics"));
    }
  };
}

export default PredictController;
