import { TrainingJobStatus } from "@shared/enums/training-job-status.enum";
import { ITrainingJob } from "../model/training-job.model";
import { TrainingTransformSpec } from "../services/training.types";

export interface CreateTrainingJobInput {
  source: string;
  tenantId?: string | null;
  createdBy: string;
  transformSpec?: TrainingTransformSpec | null;
}

class TrainingJobFactory {
  static createJob(input: CreateTrainingJobInput): Partial<ITrainingJob> {
    const job = {} as Partial<ITrainingJob>;
    job.source = input.source;
    job.status = TrainingJobStatus.QUEUED;
    job.rowsRead = 0;
    job.rowsStaged = 0;
    job.rowsRejected = 0;
    job.errors = null;
    job.tenantId = input.tenantId ?? null;
    job.createdBy = input.createdBy;
    job.transformSpec = input.transformSpec ?? null;
    return job;
  }
}

export default TrainingJobFactory;
