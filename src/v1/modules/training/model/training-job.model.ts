import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";
import { TrainingTransformSpec } from "../services/training.types";

export class TrainingJob extends Model {
  static override tableName = DB_TABLES.TRAINING_JOBS;
  static override jsonAttributes = ["errors", "transformSpec"];

  id!: string;
  source!: string;
  status!: string;
  rowsRead!: number;
  rowsStaged!: number;
  rowsRejected!: number;
  errors!: { row: number; message: string }[] | null;
  tenantId!: string | null;
  createdBy!: string;
  transformSpec!: TrainingTransformSpec | null;
  createdAt!: Date;
  startedAt!: Date | null;
  completedAt!: Date | null;
  promotedAt!: Date | null;
  promotedBy!: string | null;
  promotedRows!: number | null;
  updatedAt!: Date;
}

export type ITrainingJob = ModelObject<TrainingJob>;
