import { ObjectLiteral } from "@shared/types/object-literal.type";

export type CreateAuditTrail = {
  userId: string;
  ipAddress: string;
  device: string;
  actionType: string;
  activity: string;
  metaData: ObjectLiteral;
  os?: string;
  description?: string;
  location?: string;
};
