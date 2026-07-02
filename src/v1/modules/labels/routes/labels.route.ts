import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import LabelController from "../controller/label.controller";

const labelsRoute: FastifyPluginAsync = async (fastify) => {
  const controller = container.resolve(LabelController);

  fastify.route({
    method: "POST",
    url: "/admin/labels",
    preHandler: [requireAuth("labels:write")],
    handler: controller.ingest,
  });
};

export default labelsRoute;
