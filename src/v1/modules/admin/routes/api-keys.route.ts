import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import ApiKeysController from "../controller/api-keys.controller";
import validate from "@shared/middlewares/validator.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import {
  issueApiKeyValidationRules,
  issueApiKeyValidationMessages,
} from "../validations/api-key.validator";

const apiKeysController = container.resolve(ApiKeysController);

const apiKeysRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/admin/api-keys",
    preHandler: [requireAuth("api_keys:read")],
    handler: apiKeysController.list,
  });

  fastify.route({
    method: "POST",
    url: "/admin/api-keys",
    preHandler: [
      requireAuth("api_keys:issue"),
      validate(issueApiKeyValidationRules, issueApiKeyValidationMessages),
    ],
    handler: apiKeysController.issue,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/api-keys/:id",
    preHandler: [requireAuth("api_keys:revoke")],
    handler: apiKeysController.revoke,
  });
};

export default apiKeysRoute;
