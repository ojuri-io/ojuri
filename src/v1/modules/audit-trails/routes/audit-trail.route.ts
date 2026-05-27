import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import AuditTrailController from "../controller/audit-trail.controller";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";

const auditTrailController = container.resolve(AuditTrailController);

const auditTrailRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/audit-trails",
    preHandler: [requireAuth("audit:read")],
    handler: auditTrailController.getAll,
  });
};

export default auditTrailRoute;
