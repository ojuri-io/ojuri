import { injectable } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { TrainingJobStatus } from "@shared/enums/training-job-status.enum";
import { GroundTruthSource } from "@shared/enums/ground-truth-source.enum";
import TrainingJobNotFoundError from "@shared/error/training-job-not-found.error";
import TrainingPromoteNotReadyError from "@shared/error/training-promote-not-ready.error";
import TrainingPromoteDuplicateStagingError from "@shared/error/training-promote-duplicate-staging.error";
import TrainingJobRepo from "../repositories/training-job.repo";
import TrainingJobFactory from "../factories/training-job.factory";
import { CreateTrainingJobInput } from "../factories/training-job.factory";
import { TrainingJob } from "../model/training-job.model";

const PG_CARDINALITY_VIOLATION = "21000";
const PG_UNIQUE_VIOLATION = "23505";

const log = createServiceLogger("TrainingService");

@injectable()
class TrainingService {
  constructor(private readonly repo: TrainingJobRepo) {}

  async enqueue(input: CreateTrainingJobInput): Promise<TrainingJob> {
    const existing = await this.repo.findBySource(input.source);
    if (existing) {
      log.info("enqueue", "source already imported — returning existing job", {
        source: input.source,
        jobId: existing.id,
      });
      return existing;
    }
    const payload = TrainingJobFactory.createJob(input);
    return this.repo.save(payload);
  }

  async getById(id: string): Promise<TrainingJob> {
    const row = await TrainingJob.query().findById(id);
    if (!row) throw new TrainingJobNotFoundError(id);
    return row;
  }

  async list(opts: { limit: number; offset: number }): Promise<{ rows: TrainingJob[]; total: number }> {
    const baseQuery = TrainingJob.query();
    const total = (await baseQuery.clone().clearOrder().resultSize()) as unknown as number;
    const rows = await baseQuery
      .clone()
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(opts.limit, 1), 200))
      .offset(Math.max(opts.offset, 0));
    return { rows, total: Number(total) || 0 };
  }

  async promote(jobId: string, promotedBy: string): Promise<{ promotedRows: number }> {
    const job = await this.getById(jobId);
    if (job.status !== TrainingJobStatus.COMPLETED) {
      throw new TrainingPromoteNotReadyError(jobId, job.status as TrainingJobStatus);
    }
    if (job.promotedAt) {
      return { promotedRows: job.promotedRows ?? 0 };
    }

    const knex = TrainingJob.knex();
    // varchar(32) on transactions.groundTruthSource — the full job id
    // would overflow. Keep the per-job provenance on the trainingJob
    // row (promotedAt / promotedBy) rather than on every transaction.
    const groundTruthSource = GroundTruthSource.TRAINING_IMPORT;

    let result;
    try {
      result = await knex.raw(
        `
        INSERT INTO transactions (
          "transactionId", "senderId", "receiverId", amount, "transactionType", timestamp,
          "fraudLabel", "groundTruthFraud", "groundTruthSource", "groundTruthRecordedAt", "groundTruthRecordedBy",
          channel, currency, "accountAgeDays", "ipCountry", "transactionCountry",
          "sessionToTxnSeconds", "deviceIsTrusted", "isAuthenticated"
        )
        SELECT
          "transactionId", "senderId", "receiverId", amount, "transactionType", timestamp,
          "fraudLabel",
          COALESCE("groundTruthFraud", "fraudLabel"),
          ?,
          NOW(),
          ?,
          channel, currency, "accountAgeDays", "ipCountry", "transactionCountry",
          "sessionToTxnSeconds", "deviceIsTrusted", "isAuthenticated"
        FROM "transactionsStaging"
        WHERE "jobId" = ?
          AND COALESCE("groundTruthFraud", "fraudLabel") IS NOT NULL
        ON CONFLICT ("transactionId") DO UPDATE SET
          "groundTruthFraud" = EXCLUDED."groundTruthFraud",
          "groundTruthSource" = EXCLUDED."groundTruthSource",
          "groundTruthRecordedAt" = EXCLUDED."groundTruthRecordedAt",
          "groundTruthRecordedBy" = EXCLUDED."groundTruthRecordedBy"
        `,
        [groundTruthSource, promotedBy, jobId],
      );
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === PG_CARDINALITY_VIOLATION || code === PG_UNIQUE_VIOLATION) {
        throw new TrainingPromoteDuplicateStagingError(jobId);
      }
      throw err;
    }

    const promotedRows = (result as { rowCount?: number }).rowCount ?? 0;

    await TrainingJob.query().findById(jobId).patch({
      promotedAt: new Date(),
      promotedBy,
      promotedRows,
    });

    return { promotedRows };
  }
}

export default TrainingService;
