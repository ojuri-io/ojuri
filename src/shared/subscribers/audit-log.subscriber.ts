import events from "@shared/events";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import { EventSubscriber, On } from "event-dispatch";
import AuditTrailService from "../../v1/modules/moduleName/services/audit-trail.service";
import { container } from "tsyringe";
import { CreateAuditTrail } from "../../v1/modules/moduleName/dtos/create-audit-trail.dto";

const log = createServiceLogger("AuditLogSubscriber");

@EventSubscriber()
export class AuditLogSubscriber {
  private readonly auditTrailService: AuditTrailService;

  constructor() {
    this.auditTrailService = container.resolve(AuditTrailService);
  }

  @On(events.auditTrail.logActivity)
  async execute(data: CreateAuditTrail) {
    log.entry("execute", "Received audit trail event", {
      actionType: data.actionType,
      userId: data.userId,
      activity: data.activity,
    });

    try {
      await this.auditTrailService.createAuditTrail(data);
      log.success("execute", "Audit trail created", {
        actionType: data.actionType,
        userId: data.userId,
      });
    } catch (err) {
      log.error("execute", "Failed to create audit trail", {
        actionType: data.actionType,
        userId: data.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
