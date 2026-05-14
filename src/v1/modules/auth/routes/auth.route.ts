import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import AuthController from "../controller/auth.controller";
import validate from "@shared/middlewares/validator.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import { loginValidationRules, loginValidationMessages } from "../validations/auth.validator";

const authController = container.resolve(AuthController);

const authRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "POST",
    url: "/auth/login",
    preHandler: validate(loginValidationRules, loginValidationMessages),
    handler: authController.login,
  });

  fastify.route({
    method: "POST",
    url: "/auth/logout",
    handler: authController.logout,
  });

  fastify.route({
    method: "GET",
    url: "/auth/me",
    preHandler: requireAuth(), // any authenticated subject
    handler: authController.me,
  });
};

export default authRoute;
