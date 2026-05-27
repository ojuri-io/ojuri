import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { ObjectLiteral } from "@shared/types/object-literal.type";
import { Model, ModelObject } from "objection";

export class AuditTrail extends Model {
  static tableName = DB_TABLES.AUDIT_TRAILS;

  id: string;

  userId: string;

  ipAddress: string;

  device: string;

  actionType: string;

  activity: string;

  metaData: ObjectLiteral;

  os: string;

  description: string;

  location: string;

  user: ObjectLiteral;

  static relationMappings = {};
}

export type IAuditTrail = ModelObject<AuditTrail>;
