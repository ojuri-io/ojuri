import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class UserRole extends Model {
  static override tableName = DB_TABLES.USER_ROLES;

  id!: string;
  userId!: string;
  roleId!: string;
  assignedAt!: Date;
  assignedBy!: string | null;
}

export type IUserRole = ModelObject<UserRole>;
