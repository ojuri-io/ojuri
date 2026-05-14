import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import RulesController from "../controller/rules.controller";
import validate from "@shared/middlewares/validator.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import {
  createRuleValidationRules,
  createRuleValidationMessages,
  updateRuleValidationRules,
  updateRuleValidationMessages,
} from "../validations/rule.validator";

const rulesController = container.resolve(RulesController);

const rulesRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/admin/rules",
    preHandler: [requireAuth("rules:read")],
    handler: rulesController.list,
  });

  fastify.route({
    method: "POST",
    url: "/admin/rules",
    preHandler: [
      requireAuth("rules:create"),
      validate(createRuleValidationRules, createRuleValidationMessages),
    ],
    handler: rulesController.create,
  });

  fastify.route({
    method: "PATCH",
    url: "/admin/rules/:id",
    preHandler: [
      requireAuth("rules:update"),
      validate(updateRuleValidationRules, updateRuleValidationMessages),
    ],
    handler: rulesController.update,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/rules/:id",
    preHandler: [requireAuth("rules:delete")],
    handler: rulesController.delete,
  });
};

export default rulesRoute;
