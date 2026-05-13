import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import ApiKeysController from "../controller/api-keys.controller";
import validate from "@shared/middlewares/validator.middleware";
import {
  issueApiKeyValidationRules,
  issueApiKeyValidationMessages,
} from "../validations/api-key.validator";

const apiKeysController = container.resolve(ApiKeysController);

const apiKeysRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "POST",
    url: "/admin/api-keys",
    preHandler: validate(issueApiKeyValidationRules, issueApiKeyValidationMessages),
    handler: apiKeysController.issue,
  });

  fastify.route({
    method: "GET",
    url: "/admin/api-keys",
    handler: apiKeysController.list,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/api-keys/:id",
    handler: apiKeysController.revoke,
  });
};

export default apiKeysRoute;
