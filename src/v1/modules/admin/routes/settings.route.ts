import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import SettingsController from "../controller/settings.controller";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";

const controller = container.resolve(SettingsController);

const settingsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/admin/settings/runtime",
    preHandler: [requireAuth("settings:read")],
    handler: controller.list,
  });

  fastify.route({
    method: "PUT",
    url: "/admin/settings/runtime/:key",
    preHandler: [requireAuth("settings:write")],
    handler: controller.update,
  });
};

export default settingsRoute;
