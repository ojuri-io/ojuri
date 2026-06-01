import { injectable } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
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
}

export default TrainingService;
