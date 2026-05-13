import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import ModelsController from "../controller/models.controller";
import validate from "@shared/middlewares/validator.middleware";
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
    method: "POST",
    url: "/admin/models",
    preHandler: validate(registerModelValidationRules, registerModelValidationMessages),
    handler: modelsController.register,
  });

  fastify.route({
    method: "GET",
    url: "/admin/models",
    handler: modelsController.list,
  });

  fastify.route({
    method: "PATCH",
    url: "/admin/models/:version",
    preHandler: validate(updateModelValidationRules, updateModelValidationMessages),
    handler: modelsController.update,
  });

  fastify.route({
    method: "POST",
    url: "/admin/models/:version/status",
    preHandler: validate(setModelStatusValidationRules, setModelStatusValidationMessages),
    handler: modelsController.setStatus,
  });

  fastify.route({
    method: "POST",
    url: "/admin/segment-thresholds",
    preHandler: validate(
      setSegmentThresholdValidationRules,
      setSegmentThresholdValidationMessages
    ),
    handler: modelsController.setSegmentThreshold,
  });
};

export default modelsRoute;
