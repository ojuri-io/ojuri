import { FastifyReply, FastifyRequest } from "fastify";
import { injectable } from "tsyringe";
import httpStatus from "http-status";
import { randomUUID } from "crypto";
import PredictService from "../services/predict.service";
import { PredictRequestDto } from "../dtos/predict-request.dto";
import { IDEMPOTENCY_KEY_MAX_LENGTH } from "@shared/idempotency/idempotency.service";
import DecisionAuditService from "@shared/audit/decision-audit.service";
import WebhookService from "@shared/webhooks/webhook.service";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import { metricsService } from "@shared/metrics/metrics.service";
import { createServiceLogger, TraceContext } from "@shared/utils/logger/service-logger";

const log = createServiceLogger("PredictController");

@injectable()
class PredictController {
  constructor(
    private predictService: PredictService,
    private decisionAudit: DecisionAuditService,
    private webhookService: WebhookService
  ) {}

  predict = async (
    req: FastifyRequest<{ Body: PredictRequestDto }>,
    res: FastifyReply
  ): Promise<void> => {
    const traceId = `req-${(req.headers["x-correlation-id"] as string) || randomUUID()}`;
    const tenantId = resolveTenantId(req);
    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) || null;

    if (idempotencyKey && idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      return res
        .code(httpStatus.BAD_REQUEST)
        .header("X-Correlation-ID", traceId)
        .send(
          ErrorResponse(`Idempotency-Key must be ${IDEMPOTENCY_KEY_MAX_LENGTH} characters or fewer`)
        );
    }

    await TraceContext.runAsync(
      { traceId, transactionId: req.body.transaction_id, senderId: req.body.sender_id },
      async () => {
        try {
          const outcome = await this.predictService.executePrediction({
            request: req.body,
            traceId,
            tenantId,
            apiKeyId: req.apiKey?.id ?? null,
            idempotencyKey,
          });
          sendOutcome(res, outcome, traceId);
        } catch (err) {
          log.error("predict", "Failed to process prediction request", {
            transactionId: req.body.transaction_id,
            error: err instanceof Error ? err.message : String(err),
          });
          res
            .code(httpStatus.INTERNAL_SERVER_ERROR)
            .header("X-Correlation-ID", traceId)
            .send(ErrorResponse("Failed to process prediction request"));
        }
      }
    );
  };

  getDecision = async (
    req: FastifyRequest<{ Params: { transactionId: string } }>,
    res: FastifyReply
  ) => {
    const row = await this.decisionAudit.getByTransactionId(req.params.transactionId);
    if (!row) return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Decision not found"));
    return res.send(SuccessResponse("Decision retrieved", row));
  };

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

    const reviewer = req.auth?.username;
    if (!reviewer) {
      return res
        .code(httpStatus.UNAUTHORIZED)
        .send(ErrorResponse("Authenticated reviewer required for overrides"));
    }

    const row = await this.decisionAudit.override({ auditId, decision, reviewer, reason });
    if (!row) return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("Audit row not found"));

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
    const limit = clampInt(req.query.limit, 25, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const order = req.query.order === "oldest" ? "oldest" : "newest";
    const search = req.query.search?.trim() || undefined;
    const { rows, total, oldestPendingAt, totalPendingAmount } =
      await this.decisionAudit.listReviewQueuePaginated({
        limit,
        offset,
        order,
        search,
      });
    return res.send(
      SuccessResponse("Review queue", {
        rows,
        total,
        limit,
        offset,
        oldestPendingAt,
        totalPendingAmount,
      }),
    );
  };

  recentDecisions = async (
    req: FastifyRequest<{ Querystring: { since?: string; limit?: string } }>,
    res: FastifyReply
  ) => {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const since = req.query.since ? new Date(req.query.since) : null;
    const rows = await this.decisionAudit.listRecentSince(since, limit);
    return res.send(SuccessResponse("Recent decisions", rows));
  };

  similarDecisions = async (
    req: FastifyRequest<{ Params: { auditId: string }; Querystring: { limit?: string } }>,
    res: FastifyReply
  ) => {
    const limit = clampInt(req.query.limit, 5, 1, 20);
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

// X-Tenant-ID is only honored when a verified credential is present.
// Without this guard an unauthenticated caller could scope into another
// tenant's namespace by setting the header.
function resolveTenantId(req: FastifyRequest): string {
  const headerTenant = req.headers["x-tenant-id"] as string | undefined;
  const hasCredential = !!(req.apiKey || req.auth);
  return (
    req.apiKey?.tenantId ??
    req.auth?.tenantId ??
    (hasCredential && headerTenant ? headerTenant : undefined) ??
    "default"
  );
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function sendOutcome(
  res: FastifyReply,
  outcome: Awaited<ReturnType<PredictService["executePrediction"]>>,
  traceId: string
): void {
  res.header("X-Correlation-ID", traceId);
  switch (outcome.kind) {
    case "ok":
      res
        .code(httpStatus.OK)
        .header("X-Response-Time", `${outcome.latencyMs}ms`)
        .send(outcome.response);
      return;
    case "replay":
      res.code(httpStatus.OK).header("Idempotency-Replay", "true").send(outcome.response);
      return;
    case "conflict":
      res
        .code(httpStatus.UNPROCESSABLE_ENTITY)
        .send(ErrorResponse("Idempotency-Key reused with a different request body"));
      return;
    case "in_flight":
      res
        .code(httpStatus.CONFLICT)
        .header("Retry-After", "1")
        .send(ErrorResponse("Another request with this Idempotency-Key is still in flight"));
      return;
  }
}

export default PredictController;
