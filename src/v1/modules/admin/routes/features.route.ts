import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import FeaturesController from "../controller/features.controller";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";

const featuresController = container.resolve(FeaturesController);

const featuresRoute: FastifyPluginAsync = async (fastify) => {
  // Anyone who can read the model registry can read the catalogue. The
  // catalogue is operational metadata, not a secret — it ships in the
  // open-source repo as a JSON file. The auth check is for parity with
  // the rest of `/v1/admin/*`, not because the contents are sensitive.
  fastify.route({
    method: "GET",
    url: "/admin/features/catalog",
    preHandler: [requireAuth("models:read")],
    handler: featuresController.catalog,
  });
};

export default featuresRoute;
