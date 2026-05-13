import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import PredictController from "../controller/predict.controller";
import validate from "@shared/middlewares/validator.middleware";
import { apiKeyMiddleware } from "@shared/middlewares/api-key.middleware";
import { predictValidationRules, predictValidationMessages } from "../validations/predict.validator";

const predictController = container.resolve(PredictController);
const requireApiKey = (process.env.RDA_REQUIRE_API_KEY ?? "false").toLowerCase() === "true";

/**
 * RDA (Real-Time Detection Agent) routes
 *
 * `RDA_REQUIRE_API_KEY=true` flips the predict endpoint from open
 * to authenticated. Default is open so that the existing examples
 * in README.md still work on a fresh checkout — production
 * deployments should set this to `true`.
 */
const rdaRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "POST",
    url: "/predict",
    preHandler: [
      apiKeyMiddleware({ required: requireApiKey }),
      validate(predictValidationRules, predictValidationMessages),
    ],
    handler: predictController.predict,
  });

  fastify.route({
    method: "GET",
    url: "/decisions/:transactionId",
    preHandler: [apiKeyMiddleware({ required: requireApiKey })],
    handler: predictController.getDecision,
  });

  fastify.route({
    method: "POST",
    url: "/decisions/:auditId/override",
    preHandler: [apiKeyMiddleware({ required: requireApiKey })],
    handler: predictController.overrideDecision,
  });

  fastify.route({
    method: "GET",
    url: "/review-queue",
    preHandler: [apiKeyMiddleware({ required: requireApiKey })],
    handler: predictController.reviewQueue,
  });

  fastify.get("/metrics", {}, predictController.getMetrics);
};

export default rdaRoute;
