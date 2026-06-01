import { TrainingUploadStatus } from "@shared/enums/training-upload-status.enum";

export interface InitUploadInput {
  filename: string;
  expectedBytes: number;
  expectedSha256?: string | null;
  tenantId?: string | null;
  createdBy: string;
}

export interface UploadSessionView {
  id: string;
  filename: string;
  expectedBytes: number;
  expectedSha256: string | null;
  chunkSize: number;
  status: TrainingUploadStatus;
  bytesReceived: number;
  chunksReceived: number;
  jobId: string | null;
  expiresAt: string;
}

export interface ChunkWriteInput {
  uploadId: string;
  offset: number;
  bytes: Buffer;
}

export interface CompleteUploadResult {
  uploadId: string;
  jobId: string;
  filePath: string;
}

export interface CompleteUploadInput {
  uploadId: string;
  createdBy: string;
  transformSpec?: import("./training.types").TrainingTransformSpec | null;
}
