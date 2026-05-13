import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import WebhooksController from "../controller/webhooks.controller";
import validate from "@shared/middlewares/validator.middleware";
import {
  registerWebhookValidationRules,
  registerWebhookValidationMessages,
} from "../validations/webhook.validator";

const webhooksController = container.resolve(WebhooksController);

const webhooksRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "POST",
    url: "/admin/webhooks",
    preHandler: validate(registerWebhookValidationRules, registerWebhookValidationMessages),
    handler: webhooksController.register,
  });

  fastify.route({
    method: "GET",
    url: "/admin/webhooks",
    handler: webhooksController.list,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/webhooks/:id",
    handler: webhooksController.revoke,
  });
};

export default webhooksRoute;
