import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import SavedReportsController from "../controller/saved-reports.controller";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";

const controller = container.resolve(SavedReportsController);

const savedReportsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/admin/saved-reports/catalogue",
    preHandler: [requireAuth("saved_reports:read")],
    handler: controller.catalogue,
  });

  fastify.route({
    method: "GET",
    url: "/admin/saved-reports",
    preHandler: [requireAuth("saved_reports:read")],
    handler: controller.list,
  });

  fastify.route({
    method: "GET",
    url: "/admin/saved-reports/:id",
    preHandler: [requireAuth("saved_reports:read")],
    handler: controller.getById,
  });

  fastify.route({
    method: "POST",
    url: "/admin/saved-reports",
    preHandler: [requireAuth("saved_reports:write")],
    handler: controller.create,
  });

  fastify.route({
    method: "PATCH",
    url: "/admin/saved-reports/:id",
    preHandler: [requireAuth("saved_reports:write")],
    handler: controller.update,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/saved-reports/:id",
    preHandler: [requireAuth("saved_reports:write")],
    handler: controller.delete,
  });

  fastify.route({
    method: "POST",
    url: "/admin/saved-reports/:id/run",
    preHandler: [requireAuth("saved_reports:read")],
    handler: controller.run,
  });

  fastify.route({
    method: "POST",
    url: "/admin/saved-reports/:id/export",
    preHandler: [requireAuth("saved_reports:export")],
    handler: controller.export,
  });
};

export default savedReportsRoute;
