import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import ModelsController from "../controller/models.controller";
import validate from "@shared/middlewares/validator.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import {
  registerModelValidationRules,
  registerModelValidationMessages,
  setModelStatusValidationRules,
  setModelStatusValidationMessages,
  setSegmentThresholdValidationRules,
  setSegmentThresholdValidationMessages,
  updateModelValidationRules,
  updateModelValidationMessages,
} from "../validations/model.validator";

const modelsController = container.resolve(ModelsController);

const modelsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/admin/models",
    preHandler: [requireAuth("models:read")],
    handler: modelsController.list,
  });

  fastify.route({
    method: "GET",
    url: "/admin/models/comparison",
    preHandler: [requireAuth("models:read")],
    handler: modelsController.comparison,
  });

  fastify.route({
    method: "POST",
    url: "/admin/models",
    preHandler: [
      requireAuth("models:register"),
      validate(registerModelValidationRules, registerModelValidationMessages),
    ],
    handler: modelsController.register,
  });

  fastify.route({
    method: "PATCH",
    url: "/admin/models/:version",
    preHandler: [
      requireAuth("models:set_status"),
      validate(updateModelValidationRules, updateModelValidationMessages),
    ],
    handler: modelsController.update,
  });

  fastify.route({
    method: "POST",
    url: "/admin/models/:version/status",
    preHandler: [
      requireAuth("models:set_status"),
      validate(setModelStatusValidationRules, setModelStatusValidationMessages),
    ],
    handler: modelsController.setStatus,
  });

  fastify.route({
    method: "GET",
    url: "/admin/segment-thresholds",
    preHandler: [requireAuth("models:read")],
    handler: modelsController.listSegmentThresholds,
  });

  fastify.route({
    method: "POST",
    url: "/admin/segment-thresholds",
    preHandler: [
      requireAuth("models:set_threshold"),
      validate(setSegmentThresholdValidationRules, setSegmentThresholdValidationMessages),
    ],
    handler: modelsController.setSegmentThreshold,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/models/:version",
    preHandler: [requireAuth("models:delete")],
    handler: modelsController.delete,
  });
};

export default modelsRoute;
