import { TrainingUploadStatus } from "@shared/enums/training-upload-status.enum";
import { ITrainingUpload } from "../model/training-upload.model";
import { InitUploadInput } from "../services/training-upload.types";

const UPLOAD_TTL_MS = 60 * 60 * 1000;

class TrainingUploadFactory {
  static createSession(input: InitUploadInput, chunkSize: number): Partial<ITrainingUpload> {
    const upload = {} as Partial<ITrainingUpload>;
    upload.filename = input.filename;
    upload.expectedBytes = String(input.expectedBytes);
    upload.expectedSha256 = input.expectedSha256 ?? null;
    upload.chunkSize = chunkSize;
    upload.status = TrainingUploadStatus.IN_PROGRESS;
    upload.bytesReceived = "0";
    upload.chunksReceived = 0;
    upload.tenantId = input.tenantId ?? null;
    upload.createdBy = input.createdBy;
    upload.jobId = null;
    upload.expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
    return upload;
  }
}

export default TrainingUploadFactory;
