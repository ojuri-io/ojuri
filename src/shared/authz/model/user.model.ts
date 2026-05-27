import { DB_TABLES } from "@shared/enums/db-tables.enum";
import { Model, ModelObject } from "objection";

export class User extends Model {
  static override tableName = DB_TABLES.USERS;

  id: string;
  username: string;
  passwordHash: string;
  fullName: string | null;
  email: string | null;
  tenantId: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  disabledReason: string | null;
  mustChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type IUser = ModelObject<User>;
