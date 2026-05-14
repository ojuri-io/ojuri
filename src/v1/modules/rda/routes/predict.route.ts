import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import PredictController from "../controller/predict.controller";
import validate from "@shared/middlewares/validator.middleware";
import { apiKeyMiddleware } from "@shared/middlewares/api-key.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import { predictValidationRules, predictValidationMessages } from "../validations/predict.validator";

const predictController = container.resolve(PredictController);
const requireApiKey = (process.env.RDA_REQUIRE_API_KEY ?? "false").toLowerCase() === "true";

/**
 * RDA (Real-Time Detection Agent) routes
 *
 * Two auth modes coexist here:
 *   - `/predict` stays on API-key auth (`X-Api-Key`) because the hot
 *     path is programmatic — payment systems call it server-to-server.
 *     `RDA_REQUIRE_API_KEY=true` makes the key mandatory; default is
 *     open so the existing README examples still work on a fresh
 *     checkout.
 *   - The audit / review-queue / override routes are dashboard-facing
 *     and use the same JWT `requireAuth(...)` guard as `/v1/admin/*`.
 *     This is what lets the Sentinel UI's Review queue and
 *     Transaction detail pages talk to them.
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
    url: "/decisions/recent",
    preHandler: [requireAuth("audit:read")],
    handler: predictController.recentDecisions,
  });

  fastify.route({
    method: "GET",
    url: "/decisions/:auditId/similar",
    preHandler: [requireAuth("audit:read")],
    handler: predictController.similarDecisions,
  });

  fastify.route({
    method: "GET",
    url: "/decisions/:transactionId",
    preHandler: [requireAuth("audit:read")],
    handler: predictController.getDecision,
  });

  fastify.route({
    method: "POST",
    url: "/decisions/:auditId/override",
    preHandler: [requireAuth("review_queue:override")],
    handler: predictController.overrideDecision,
  });

  fastify.route({
    method: "GET",
    url: "/review-queue",
    preHandler: [requireAuth("review_queue:read")],
    handler: predictController.reviewQueue,
  });

  fastify.get("/metrics", {}, predictController.getMetrics);
};

export default rdaRoute;
