import logger from "@shared/utils/logger";
import { injectable } from "tsyringe";
import { CreateAuditTrail } from "../dtos/create-audit-trail.dto";
import AuditTrailFactory from "../factories/audit-trail.factory";
import { IAuditTrail } from "../model/audit-trail.model";
import AuditTrailRepo from "../repositories/audit-trail.repo";

@injectable()
class AuditTrailService {
  constructor(private readonly auditTrailRepo: AuditTrailRepo) {}

  async createAuditTrail(data: CreateAuditTrail) {
    const auditTrail = AuditTrailFactory.createAuditTrail(data);

    return await this.auditTrailRepo
      .save(auditTrail)
      .catch((error) => this.handleAuditCreationError(auditTrail, error));
  }

  async getAll() {
    return await this.auditTrailRepo.getAll();
  }

  private handleAuditCreationError = (auditTrail: IAuditTrail, error: any) => {
    logger.error(
      { error, auditTrail },
      "AuditTrailService[handleAuditCreationError]: Error occured creating audit-trails."
    );
  };
}

export default AuditTrailService;
