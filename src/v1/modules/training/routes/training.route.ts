import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import TrainingController from "../controller/training.controller";

const trainingRoute: FastifyPluginAsync = async (fastify) => {
  const controller = container.resolve(TrainingController);

  fastify.route({
    method: "POST",
    url: "/admin/training/import",
    preHandler: [requireAuth("training:write")],
    handler: controller.createImport,
  });

  fastify.route({
    method: "GET",
    url: "/admin/training/imports",
    preHandler: [requireAuth("training:read")],
    handler: controller.listImports,
  });

  fastify.route({
    method: "GET",
    url: "/admin/training/import/:jobId",
    preHandler: [requireAuth("training:read")],
    handler: controller.getImport,
  });
};

export default trainingRoute;
