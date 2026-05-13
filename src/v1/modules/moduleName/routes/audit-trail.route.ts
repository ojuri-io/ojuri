import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import AuditTrailController from "../controller/audit-trail.controller";

const auditTrailController = container.resolve(AuditTrailController);

const auditTrailRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/audit-trails",
    onRequest: [],
    handler: auditTrailController.getAll,
  });
};

export default auditTrailRoute;
