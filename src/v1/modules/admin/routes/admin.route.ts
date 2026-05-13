import { FastifyPluginAsync } from "fastify";
import { adminTokenMiddleware } from "@shared/middlewares/api-key.middleware";
import apiKeysRoute from "./api-keys.route";
import webhooksRoute from "./webhooks.route";
import modelsRoute from "./models.route";
import rulesRoute from "./rules.route";

/**
 * Admin / management routes — gated by the static `RDA_ADMIN_TOKEN`.
 * Sub-routes are split per resource (api-keys, webhooks, models,
 * rules) so each one mirrors the rda module's `controller / routes /
 * services / dtos / validations` layout. The token guard is applied
 * here once so individual sub-routes stay focused on their resource.
 */
const adminRoute: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", adminTokenMiddleware());

  fastify.register(apiKeysRoute);
  fastify.register(webhooksRoute);
  fastify.register(modelsRoute);
  fastify.register(rulesRoute);
};

export default adminRoute;
