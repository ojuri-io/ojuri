import { injectable } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { TrainingJobStatus } from "@shared/enums/training-job-status.enum";
import TrainingJobNotFoundError from "@shared/error/training-job-not-found.error";
import TrainingJobRepo from "../repositories/training-job.repo";
import TrainingJobFactory from "../factories/training-job.factory";
import { CreateTrainingJobInput } from "../factories/training-job.factory";
import { TrainingJob } from "../model/training-job.model";

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
      throw new Error(`Cannot promote: job status is ${job.status}, must be COMPLETED`);
    }
    if (job.promotedAt) {
      return { promotedRows: job.promotedRows ?? 0 };
    }

    const knex = TrainingJob.knex();
    const groundTruthSource = `training_import:${jobId}`;

    const result = await knex.raw(
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
