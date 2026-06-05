import { promises as fs } from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { URL } from "url";
import { injectable } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { TrainingSourceKind } from "@shared/enums/training-source-kind.enum";
import TrainingSourceUnsupportedError from "@shared/error/training-source-unsupported.error";
import { TrainingJob } from "../model/training-job.model";
import TrainingJobRepo from "../repositories/training-job.repo";
import { parseCsvHeader, parseCsvRow } from "./csv-row.parser";
import { ParsedTransactionRow, TrainingRowError, TrainingTransformSpec } from "./training.types";

const log = createServiceLogger("TrainingImportWorker");

const POLL_INTERVAL_MS = Number(process.env.TRAINING_WORKER_POLL_MS) || 2000;
const STAGING_BATCH_SIZE = 1000;

function isMissingRelationError(err: unknown): boolean {
  // Postgres "undefined_table" (42P01) surfaces as a DBError whose
  // message ends with `relation "X" does not exist`. We hit it when
  // RDA boots before `npm run db:migrate` — the same condition that
  // RuntimeSettings / ModelRegistry / Rules already log at WARN.
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("does not exist");
}

@injectable()
class TrainingImportWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private missingSchemaWarned = false;

  constructor(private readonly repo: TrainingJobRepo) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drain().catch((err) => {
        if (isMissingRelationError(err)) {
          if (!this.missingSchemaWarned) {
            log.warn("drain", "trainingJobs table not found - skipping poll until migrations run");
            this.missingSchemaWarned = true;
          }
          return;
        }
        log.error("drain", "drain failed", { err: String(err) });
      });
    }, POLL_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    log.success("start", "Training import worker started", { pollMs: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async drain(): Promise<void> {
    if (this.inFlight) return;
    const job = await this.repo.claimNextQueued();
    if (!job) return;
    this.inFlight = true;
    try {
      await this.runJob(job);
    } finally {
      this.inFlight = false;
    }
  }

  async runJob(job: TrainingJob): Promise<void> {
    try {
      const kind = sourceKind(job.source);
      if (kind === TrainingSourceKind.S3) {
        throw new TrainingSourceUnsupportedError(job.source);
      }
      const filePath = parseFilePath(job.source);
      const { rowsRead, rowsStaged, rowsRejected, errors } = await this.streamCsvIntoStaging(
        job.id,
        filePath,
        job.transformSpec,
      );
      await this.repo.markCompleted(job.id, { rowsRead, rowsStaged, rowsRejected }, errors);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("runJob", "training import failed", { jobId: job.id, err: msg });
      await this.repo.markFailed(job.id, msg);
    }
  }

  private async streamCsvIntoStaging(
    jobId: string,
    filePath: string,
    spec: TrainingTransformSpec | null,
  ): Promise<{
    rowsRead: number;
    rowsStaged: number;
    rowsRejected: number;
    errors: TrainingRowError[];
  }> {
    await fs.access(filePath);
    const knex = TrainingJob.knex();
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });

    let header: string[] | null = null;
    let lineNumber = 0;
    let rowsRead = 0;
    let rowsStaged = 0;
    let rowsRejected = 0;
    const errors: TrainingRowError[] = [];
    let batch: ParsedTransactionRow[] = [];

    for await (const line of reader) {
      lineNumber++;
      if (!line.trim()) continue;
      if (header === null) {
        const parsed = parseCsvHeader(line, spec);
        if (parsed.missing.length > 0) {
          throw new Error(`CSV missing required columns: ${parsed.missing.join(", ")}`);
        }
        header = parsed.columns;
        continue;
      }
      rowsRead++;
      const parsed = parseCsvRow(header, line, spec);
      if (parsed.error || !parsed.row) {
        rowsRejected++;
        if (errors.length < 100) errors.push({ row: lineNumber, message: parsed.error ?? "unknown" });
        continue;
      }
      batch.push(parsed.row);
      if (batch.length >= STAGING_BATCH_SIZE) {
        rowsStaged += await this.flushBatch(knex, jobId, batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      rowsStaged += await this.flushBatch(knex, jobId, batch);
    }
    return { rowsRead, rowsStaged, rowsRejected, errors };
  }

  private async flushBatch(
    knex: ReturnType<typeof TrainingJob.knex>,
    jobId: string,
    batch: ParsedTransactionRow[],
  ): Promise<number> {
    const rows = batch.map((r) => ({ jobId, ...r }));
    await knex(DB_TABLES.TRANSACTIONS_STAGING).insert(rows);
    return rows.length;
  }
}

function sourceKind(source: string): TrainingSourceKind {
  if (source.startsWith("file://")) return TrainingSourceKind.FILE;
  if (source.startsWith("s3://")) return TrainingSourceKind.S3;
  throw new TrainingSourceUnsupportedError(source);
}

function parseFilePath(source: string): string {
  const url = new URL(source);
  return url.pathname;
}

export default TrainingImportWorker;
