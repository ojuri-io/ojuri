import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import AuditController from "../controller/audit.controller";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";

const auditController = container.resolve(AuditController);

const auditRoute: FastifyPluginAsync = async (fastify) => {
  // Reason-code enum used by the Audit log filter chip set.
  fastify.route({
    method: "GET",
    url: "/admin/audit/reason-codes",
    preHandler: [requireAuth("audit:read")],
    handler: auditController.reasonCodes,
  });

  // The Audit log page reads here.
  fastify.route({
    method: "GET",
    url: "/admin/audit",
    preHandler: [requireAuth("audit:read")],
    handler: auditController.list,
  });

  // The Transactions list page reads here. Same shape, same data —
  // hosted at /v1/transactions because that's how every other
  // payment-system surfaces a transaction list.
  fastify.route({
    method: "GET",
    url: "/transactions",
    preHandler: [requireAuth("audit:read")],
    handler: auditController.list,
  });
};

export default auditRoute;
