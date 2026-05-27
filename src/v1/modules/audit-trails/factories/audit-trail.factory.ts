import { ObjectLiteral } from "@shared/types/object-literal.type";
import { CreateAuditTrail } from "../dtos/create-audit-trail.dto";
import { IAuditTrail } from "../model/audit-trail.model";

class AuditTrailFactory {
  static createAuditTrail(data: CreateAuditTrail) {
    const auditTrail = {} as IAuditTrail;

    auditTrail.actionType = data.actionType;
    auditTrail.activity = data.activity;
    auditTrail.description = String(data.description);
    auditTrail.device = data.device;
    auditTrail.ipAddress = data.ipAddress;
    auditTrail.userId = data.userId;
    auditTrail.os = String(data.os);
    auditTrail.location = String(data.location);
    auditTrail.metaData = data.metaData as ObjectLiteral;

    return auditTrail;
  }
}

export default AuditTrailFactory;
