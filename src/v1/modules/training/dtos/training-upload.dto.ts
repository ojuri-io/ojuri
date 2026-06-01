import { TrainingUploadStatus } from "@shared/enums/training-upload-status.enum";

export interface InitUploadRequestDto {
  filename: string;
  expectedBytes: number;
  expectedSha256?: string;
}

export interface InitUploadResponseDto {
  uploadId: string;
  chunkSize: number;
  expiresAt: string;
}

export interface UploadStatusResponseDto {
  uploadId: string;
  filename: string;
  status: TrainingUploadStatus;
  bytesReceived: number;
  expectedBytes: number;
  chunksReceived: number;
  jobId: string | null;
}

export interface CompleteUploadResponseDto {
  uploadId: string;
  jobId: string;
  source: string;
}
