import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import WebhooksController from "../controller/webhooks.controller";
import validate from "@shared/middlewares/validator.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import {
  registerWebhookValidationRules,
  registerWebhookValidationMessages,
} from "../validations/webhook.validator";

const webhooksController = container.resolve(WebhooksController);

const webhooksRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/admin/webhooks",
    preHandler: [requireAuth("webhooks:read")],
    handler: webhooksController.list,
  });

  fastify.route({
    method: "POST",
    url: "/admin/webhooks",
    preHandler: [
      requireAuth("webhooks:create"),
      validate(registerWebhookValidationRules, registerWebhookValidationMessages),
    ],
    handler: webhooksController.register,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/webhooks/:id",
    preHandler: [requireAuth("webhooks:delete")],
    handler: webhooksController.revoke,
  });

  fastify.route({
    method: "GET",
    url: "/admin/webhook-deliveries",
    preHandler: [requireAuth("webhooks:read")],
    handler: webhooksController.listDeliveries,
  });
};

export default webhooksRoute;
