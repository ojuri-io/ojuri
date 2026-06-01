import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import TrainingController from "../controller/training.controller";
import TrainingUploadController from "../controller/training-upload.controller";
import { CHUNK_SIZE } from "../services/training-upload.service";

const trainingRoute: FastifyPluginAsync = async (fastify) => {
  const controller = container.resolve(TrainingController);
  const upload = container.resolve(TrainingUploadController);

  fastify.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: CHUNK_SIZE + 1024 },
    (_req, body, done) => done(null, body),
  );

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

  fastify.route({
    method: "POST",
    url: "/admin/training/upload/init",
    preHandler: [requireAuth("training:write")],
    handler: upload.init,
  });

  fastify.route({
    method: "PUT",
    url: "/admin/training/upload/:uploadId/chunk",
    preHandler: [requireAuth("training:write")],
    handler: upload.chunk,
    bodyLimit: CHUNK_SIZE + 1024,
  });

  fastify.route({
    method: "POST",
    url: "/admin/training/upload/:uploadId/complete",
    preHandler: [requireAuth("training:write")],
    handler: upload.complete,
  });

  fastify.route({
    method: "GET",
    url: "/admin/training/upload/:uploadId",
    preHandler: [requireAuth("training:read")],
    handler: upload.status,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/training/upload/:uploadId",
    preHandler: [requireAuth("training:write")],
    handler: upload.abandon,
  });
};

export default trainingRoute;
