import { injectable } from "tsyringe";
import { BaseRepository } from "@shared/repositories/base.repo";
import { ITrainingUpload, TrainingUpload } from "../model/training-upload.model";
import { TrainingUploadStatus } from "@shared/enums/training-upload-status.enum";

@injectable()
class TrainingUploadRepo extends BaseRepository<ITrainingUpload, TrainingUpload> {
  constructor() {
    super(TrainingUpload);
  }

  async findByIdOrNull(id: string): Promise<TrainingUpload | undefined> {
    return TrainingUpload.query().findById(id);
  }

  async recordChunkAppend(id: string, newBytesReceived: number): Promise<void> {
    await TrainingUpload.query().findById(id).patch({
      bytesReceived: String(newBytesReceived),
      chunksReceived: TrainingUpload.raw('"chunksReceived" + 1') as unknown as number,
    });
  }

  async markComplete(id: string, jobId: string): Promise<void> {
    await TrainingUpload.query().findById(id).patch({
      status: TrainingUploadStatus.COMPLETE,
      jobId,
      completedAt: new Date(),
    });
  }

  async markAbandoned(id: string): Promise<void> {
    await TrainingUpload.query().findById(id).patch({
      status: TrainingUploadStatus.ABANDONED,
      completedAt: new Date(),
    });
  }
}

export default TrainingUploadRepo;
