import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import PredictController from "../controller/predict.controller";
import validate from "@shared/middlewares/validator.middleware";
import { predictValidationRules, predictValidationMessages } from "../validations/predict.validator";

const predictController = container.resolve(PredictController);

/**
 * RDA (Real-Time Detection Agent) routes
 */
const rdaRoute: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /predict
   * Main fraud detection endpoint
   * Accepts transaction details and returns fraud prediction
   */
  fastify.route({
    method: "POST",
    url: "/predict",
    preHandler: validate(predictValidationRules, predictValidationMessages),
    handler: predictController.predict,
  });

  /**
   * GET /metrics
   * Prometheus metrics endpoint
   */
  fastify.get("/metrics", {}, predictController.getMetrics);
};

export default rdaRoute;
