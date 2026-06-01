import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class TrainingUpload extends Model {
  static override tableName = DB_TABLES.TRAINING_UPLOADS;

  id!: string;
  filename!: string;
  expectedBytes!: string;
  expectedSha256!: string | null;
  chunkSize!: number;
  status!: string;
  bytesReceived!: string;
  chunksReceived!: number;
  tenantId!: string | null;
  createdBy!: string;
  jobId!: string | null;
  createdAt!: Date;
  completedAt!: Date | null;
  expiresAt!: Date;
}

export type ITrainingUpload = ModelObject<TrainingUpload>;
