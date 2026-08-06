import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { DecisionAudit } from "./model/decision-audit.model";
import { AuditWriteQueueOptions, QueuedAuditRecord } from "./decision-audit.types";
import AuditRowFactory from "./factories/audit-row.factory";
import AuditQueueBackpressureError from "@shared/error/audit-queue-backpressure.error";

const log = createServiceLogger("AuditWriteQueue");

// Postgres SQLSTATE classes worth retrying: connection failure,
// insufficient resources, operator intervention, transaction rollback.
// Anything else (undefined column, bad data, constraint violation) will
// fail identically on every retry.
const TRANSIENT_SQLSTATE_CLASSES = ["08", "53", "57", "40"];

function isTransient(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  // No SQLSTATE at all is usually a driver/socket error — retry those.
  if (typeof code !== "string") return true;
  return TRANSIENT_SQLSTATE_CLASSES.some((cls) => code.startsWith(cls));
}

const DEFAULTS: AuditWriteQueueOptions = {
  capacity: Number(process.env.AUDIT_QUEUE_CAPACITY) || 50_000,
  flushIntervalMs: Number(process.env.AUDIT_QUEUE_FLUSH_MS) || 50,
  batchSize: Number(process.env.AUDIT_QUEUE_BATCH_SIZE) || 500,
};

@singleton()
class AuditWriteQueue {
  private buffer: QueuedAuditRecord[] = [];
  private flushing = false;
  private consecutiveFailures = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: AuditWriteQueueOptions;

  constructor() {
    this.opts = DEFAULTS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((err) => log.error("flush", "Background flush failed", { err: String(err) }));
    }, this.opts.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
    log.success("start", "Audit write queue started", {
      capacity: this.opts.capacity,
      flushIntervalMs: this.opts.flushIntervalMs,
      batchSize: this.opts.batchSize,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Bounded: flush() re-queues on failure, so an unreachable Postgres
    // at shutdown would otherwise spin here forever.
    const maxAttempts = Math.ceil(this.buffer.length / this.opts.batchSize) + 3;
    for (let i = 0; i < maxAttempts && this.buffer.length > 0; i++) {
      const before = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= before) break;
    }
    if (this.buffer.length > 0) {
      log.error("stop", "Shutting down with unflushed audit rows", { pending: this.buffer.length });
    }
  }

  enqueue(rec: QueuedAuditRecord): void {
    if (this.buffer.length >= this.opts.capacity) {
      metricsService.recordAuditWriteFailure("backpressure");
      throw new AuditQueueBackpressureError(this.opts.capacity);
    }
    this.buffer.push(rec);
  }

  depth(): number {
    return this.buffer.length;
  }

  /**
   * Late-binding write for values that resolve after the response has
   * been sent (shadow scores). Returns false once the row has flushed —
   * the caller treats that as "not recorded" rather than racing the
   * insert with an UPDATE.
   */
  patch(id: string, fields: Partial<QueuedAuditRecord>): boolean {
    const rec = this.buffer.find((r) => r.id === id);
    if (!rec) return false;
    Object.assign(rec, fields);
    return true;
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.opts.batchSize);
    try {
      const rows = batch.map(AuditRowFactory.toInsertRow);
      const knex = DecisionAudit.knex();
      // ON CONFLICT — a racy duplicate (Redis SETNX bypassed or two
      // concurrent writers) collapses to a single audit row.
      const result = await knex(DB_TABLES.DECISION_AUDIT_LOG)
        .insert(rows)
        .onConflict(["tenantId", "transactionId"])
        .ignore();
      const inserted = Array.isArray(result) ? result.length : (result as { rowCount?: number })?.rowCount ?? rows.length;
      const dropped = rows.length - inserted;
      if (dropped > 0) {
        metricsService.recordAuditWriteFailure("duplicate", dropped);
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      metricsService.recordAuditWriteFailure("flush_error");

      // Retrying a batch Postgres will never accept (missing column,
      // bad data, failed constraint) blocks the queue head forever, and
      // a full queue makes enqueue() throw — which would turn an audit
      // outage into a total outage of the decision path. Only transient
      // failures go back on the queue.
      if (isTransient(err)) {
        this.requeue(batch);
        log.error("flush", "Audit batch write failed; retrying", {
          err: String(err),
          batchSize: batch.length,
          consecutiveFailures: this.consecutiveFailures,
        });
        return;
      }

      metricsService.recordAuditWriteFailure("dropped", batch.length);
      log.error("flush", "Audit batch rejected by Postgres; dropping to the log", {
        err: String(err),
        batchSize: batch.length,
        deadLetter: batch.map((r) => ({ id: r.id, transactionId: r.transactionId })),
      });
    } finally {
      this.flushing = false;
    }
  }

  private requeue(batch: QueuedAuditRecord[]): void {
    const room = this.opts.capacity - this.buffer.length;
    const dropped = batch.length - room;
    if (dropped > 0) {
      metricsService.recordAuditWriteFailure("dropped", dropped);
      log.error("flush", "Audit buffer full; dropping oldest rows", { dropped });
    }
    this.buffer.unshift(...batch.slice(Math.max(0, dropped)));
  }
}

export default AuditWriteQueue;
