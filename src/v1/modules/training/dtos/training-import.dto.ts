import { TrainingJobStatus } from "@shared/enums/training-job-status.enum";

export interface CreateTrainingImportDto {
  source: string;
}

export interface TrainingImportJobResponseDto {
  jobId: string;
  source: string;
  status: TrainingJobStatus;
  rowsRead: number;
  rowsStaged: number;
  rowsRejected: number;
  errors: { row: number; message: string }[] | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  promotedAt: string | null;
  promotedBy: string | null;
  promotedRows: number | null;
}
