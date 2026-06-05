import { injectable } from "tsyringe";
import { BaseRepository } from "@shared/repositories/base.repo";
import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { TrainingJob, ITrainingJob } from "../model/training-job.model";
import { TrainingJobStatus } from "@shared/enums/training-job-status.enum";

@injectable()
class TrainingJobRepo extends BaseRepository<ITrainingJob, TrainingJob> {
  constructor() {
    super(TrainingJob);
  }

  async findBySource(source: string): Promise<TrainingJob | undefined> {
    return TrainingJob.query().where({ source }).first();
  }

  // Atomic pickup: locks one QUEUED row, flips it to RUNNING, returns it.
  // Multiple replicas can poll concurrently; SKIP LOCKED ensures each row
  // is claimed by exactly one worker. Without this, every replica's
  // worker streams the same CSV into transactionsStaging in parallel.
  async claimNextQueued(): Promise<TrainingJob | undefined> {
    const knex = TrainingJob.knex();
    const result = await knex.raw(
      `
      UPDATE "${DB_TABLES.TRAINING_JOBS}"
         SET status = ?,
             "startedAt" = NOW(),
             "updatedAt" = NOW()
       WHERE id = (
         SELECT id FROM "${DB_TABLES.TRAINING_JOBS}"
          WHERE status = ?
          ORDER BY "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING *
      `,
      [TrainingJobStatus.RUNNING, TrainingJobStatus.QUEUED],
    );
    const row = (result as { rows?: ITrainingJob[] }).rows?.[0];
    return row ? TrainingJob.fromJson(row, { skipValidation: true }) : undefined;
  }

  async markCompleted(
    id: string,
    counters: { rowsRead: number; rowsStaged: number; rowsRejected: number },
    errors: { row: number; message: string }[],
  ): Promise<void> {
    await TrainingJob.query().findById(id).patch({
      status: TrainingJobStatus.COMPLETED,
      rowsRead: counters.rowsRead,
      rowsStaged: counters.rowsStaged,
      rowsRejected: counters.rowsRejected,
      errors: errors.length > 0 ? errors : null,
      completedAt: new Date(),
    });
  }

  async markFailed(id: string, message: string): Promise<void> {
    await TrainingJob.query().findById(id).patch({
      status: TrainingJobStatus.FAILED,
      errors: [{ row: 0, message }],
      completedAt: new Date(),
    });
  }
}

export default TrainingJobRepo;
