import { randomUUID } from "crypto";
import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import DecisionAuditRepo, { AuditListFilters } from "./repositories/decision-audit.repo";
import { DecisionAudit } from "./model/decision-audit.model";
import AuditWriteQueue from "./audit-write-queue";
import { GroundTruthSource } from "@shared/enums/ground-truth-source.enum";
import { DecisionAuditRecord, DecisionAuditRecordResult } from "./decision-audit.types";

export type { DecisionAuditRecord, DecisionAuditRecordResult };

const log = createServiceLogger("DecisionAudit");

// Postgres unique-violation SQLSTATE. Surfaced on Objection / pg errors
// as `err.code`; we narrow to this specific value so generic failures
// still hit the "swallow & log" branch (audit failures must never break
// the decision path).
const PG_UNIQUE_VIOLATION = "23505";

@singleton()
class DecisionAuditService {
  constructor(
    private readonly repo: DecisionAuditRepo,
    private readonly queue: AuditWriteQueue,
  ) {}

  // Hot-path entry: enqueue the audit row to a background buffer and
  // return the id the caller will surface in the response + Kafka event.
  // Throws BackpressureError if the queue is full — the route handler
  // maps that to HTTP 503 so Postgres outages don't silently corrupt
  // the decisioning path.
  enqueue(rec: DecisionAuditRecord): string {
    const id = randomUUID();
    this.queue.enqueue({ ...rec, id });
    return id;
  }

  async record(rec: DecisionAuditRecord): Promise<DecisionAuditRecordResult> {
    try {
      const row = await this.repo.save({
        transactionId: rec.transactionId,
        tenantId: rec.tenantId ?? null,
        apiKeyId: rec.apiKeyId ?? null,
        correlationId: rec.correlationId ?? null,
        idempotencyKey: rec.idempotencyKey ?? null,

        senderId: rec.senderId,
        receiverId: rec.receiverId ?? null,
        amount: rec.amount,
        transactionType: rec.transactionType ?? null,
        segment: rec.segment ?? null,

        championModelVersion: rec.championModelVersion,
        shadowModelVersion: rec.shadowModelVersion ?? null,
        championScore: rec.championScore,
        shadowScore: rec.shadowScore ?? null,
        threshold: rec.threshold,

        mlDecision: rec.mlDecision,
        finalDecision: rec.finalDecision,
        decisionSource: rec.decisionSource,

        ruleId: rec.ruleId ?? null,
        ruleName: rec.ruleName ?? null,
        ruleStage: rec.ruleStage ?? null,
        ruleExpression: rec.ruleExpression ?? null,
        ruleAction: rec.ruleAction ?? null,

        reasonCodes: rec.reasonCodes ?? null,
        featuresSnapshot: rec.featuresSnapshot ?? null,
        featuresDefault: rec.featuresDefault ?? false,

        latencyMs: rec.latencyMs,
      });

      return { kind: "ok", id: row.id };
    } catch (err) {
      if (isUniqueViolation(err)) {
        log.warn("record", "Duplicate (tenantId, transactionId) — replay rejected", {
          tenantId: rec.tenantId ?? null,
          transactionId: rec.transactionId,
        });
        metricsService.recordAuditWriteFailure("duplicate");
        return { kind: "duplicate" };
      }
      // Audit-log failures must never break the decision path. The
      // counter makes a sustained spike alertable instead of a silent
      // regression in case-management coverage.
      log.error("record", "Failed to persist decision audit row", {
        transactionId: rec.transactionId,
        err: String(err),
      });
      metricsService.recordAuditWriteFailure("record");
      return { kind: "failed" };
    }
  }

  async override(input: {
    auditId: string;
    reviewer: string;
    decision: "ACCEPT" | "DECLINE";
    reason?: string;
  }): Promise<DecisionAudit | null> {
    const row = await this.repo.applyOverride({
      auditId: input.auditId,
      reviewer: input.reviewer,
      decision: input.decision,
      reason: input.reason ?? null,
    });

    // Propagate the verified verdict to `transactions.groundTruthFraud`
    // so MLA's next retrain uses this row as a real label instead of
    // the system's own prior decision. This is the feedback loop:
    // human review → ground truth → next model.
    //
    // Mapping: DECLINE override = "reviewer confirmed fraud" = true.
    //          ACCEPT  override = "reviewer cleared it"      = false.
    //
    // Best-effort — a missing matching transactions row (e.g. PAA
    // hadn't flushed yet) just means we'll wait for the next
    // override on a later prediction; we don't fail the override
    // on a label-write hiccup.
    if (row) {
      try {
        await this.repo.writeGroundTruth({
          transactionId: row.transactionId,
          groundTruthFraud: input.decision === "DECLINE",
          source: GroundTruthSource.REVIEWER_OVERRIDE,
          recordedBy: input.reviewer,
        });
      } catch (err) {
        log.warn("override", "Ground-truth write failed; override still recorded", {
          transactionId: row.transactionId,
          err: String(err),
        });
      }
    }

    return row ?? null;
  }

  async getByTransactionId(transactionId: string): Promise<DecisionAudit | null> {
    const row = await this.repo.findLatestByTransactionId(transactionId);
    return row ?? null;
  }

  async getById(id: string): Promise<DecisionAudit | null> {
    const row = await this.repo.findById(id);
    return row ?? null;
  }

  async listReviewQueue(opts?: { limit?: number }): Promise<DecisionAudit[]> {
    return this.repo.listReviewQueue(opts?.limit ?? 100);
  }

  async listReviewQueuePaginated(opts: {
    limit: number;
    offset: number;
    order?: "newest" | "oldest";
    search?: string;
  }): Promise<{
    rows: DecisionAudit[];
    total: number;
    oldestPendingAt: Date | null;
    totalPendingAmount: number;
  }> {
    return this.repo.listReviewQueuePaginated(opts);
  }

  async listFiltered(filters: AuditListFilters) {
    return this.repo.listFiltered(filters);
  }

  async listRecentSince(since: Date | null, limit: number) {
    return this.repo.listRecentSince(since, limit);
  }

  async listSimilar(auditId: string, limit: number) {
    return this.repo.listSimilar(auditId, limit);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown; nativeError?: { code?: unknown } }).code
    ?? (err as { nativeError?: { code?: unknown } }).nativeError?.code;
  return code === PG_UNIQUE_VIOLATION;
}

export default DecisionAuditService;
