import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { DecisionAudit } from "./model/decision-audit.model";
import { AuditWriteQueueOptions, QueuedAuditRecord } from "./decision-audit.types";
import AuditRowFactory from "./factories/audit-row.factory";
import AuditQueueBackpressureError from "@shared/error/audit-queue-backpressure.error";

const log = createServiceLogger("AuditWriteQueue");

const DEFAULTS: AuditWriteQueueOptions = {
  capacity: Number(process.env.AUDIT_QUEUE_CAPACITY) || 50_000,
  flushIntervalMs: Number(process.env.AUDIT_QUEUE_FLUSH_MS) || 50,
  batchSize: Number(process.env.AUDIT_QUEUE_BATCH_SIZE) || 500,
};

@singleton()
class AuditWriteQueue {
  private buffer: QueuedAuditRecord[] = [];
  private flushing = false;
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
    while (this.buffer.length > 0) {
      await this.flush();
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

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.buffer.splice(0, this.opts.batchSize);
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
    } catch (err) {
      log.error("flush", "Audit batch write failed; rows dropped", {
        err: String(err),
        droppedRows: this.opts.batchSize,
      });
      metricsService.recordAuditWriteFailure("flush_error");
    } finally {
      this.flushing = false;
    }
  }
}

export default AuditWriteQueue;
