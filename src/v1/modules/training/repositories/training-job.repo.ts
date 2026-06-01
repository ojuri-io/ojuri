import { injectable } from "tsyringe";
import { BaseRepository } from "@shared/repositories/base.repo";
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

  async findOneQueued(): Promise<TrainingJob | undefined> {
    return TrainingJob.query()
      .where({ status: TrainingJobStatus.QUEUED })
      .orderBy("createdAt", "asc")
      .first();
  }

  async markRunning(id: string): Promise<void> {
    await TrainingJob.query().findById(id).patch({
      status: TrainingJobStatus.RUNNING,
      startedAt: new Date(),
    });
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
