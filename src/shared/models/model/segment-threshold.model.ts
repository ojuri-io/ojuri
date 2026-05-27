import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class SegmentThreshold extends Model {
  static override tableName = DB_TABLES.SEGMENT_THRESHOLDS;

  id: string;
  segment: string;
  modelVersion: string;
  threshold: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ISegmentThreshold = ModelObject<SegmentThreshold>;
