import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import StatsController from "../controller/stats.controller";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";

const statsController = container.resolve(StatsController);

const statsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/stats/today",
    preHandler: [requireAuth("metrics:read")],
    handler: statsController.today,
  });

  fastify.route({
    method: "GET",
    url: "/stats/window",
    preHandler: [requireAuth("metrics:read")],
    handler: statsController.window,
  });

  fastify.route({
    method: "GET",
    url: "/stats/latency",
    preHandler: [requireAuth("metrics:read")],
    handler: statsController.latency,
  });
};

export default statsRoute;
