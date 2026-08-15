import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import AuthController from "../controller/auth.controller";
import validate from "@shared/middlewares/validator.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import { ipRateLimit } from "@shared/middlewares/ip-rate-limit.middleware";
import { loginValidationRules, loginValidationMessages } from "../validations/auth.validator";

const authController = container.resolve(AuthController);

const authRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "POST",
    url: "/auth/login",
    // Per-IP throttle to stop credential-stuffing scripts. The
    // bcrypt-on-every-branch change in AuthService keeps the timing
    // closed; this caps the volume an attacker can throw at it.
    preHandler: [
      ipRateLimit({
        envKey: "AUTH_LOGIN_RATE_LIMIT_PER_MINUTE",
        ratePerMinute: 20,
        routeLabel: "auth.login",
      }),
      validate(loginValidationRules, loginValidationMessages),
    ],
    handler: authController.login,
  });

  // Unauthenticated by necessity — the sign-in page reads it before anyone has
  // a token. It answers one question: is there a public demo account on this
  // deployment. On a self-hosted install the answer is always null.
  fastify.route({
    method: "GET",
    url: "/auth/sign-in-options",
    preHandler: [
      ipRateLimit({
        envKey: "AUTH_SIGN_IN_OPTIONS_RATE_LIMIT_PER_MINUTE",
        ratePerMinute: 60,
        routeLabel: "auth.sign-in-options",
      }),
    ],
    handler: authController.signInOptions,
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

  fastify.route({
    method: "POST",
    url: "/auth/change-password",
    // Any authenticated user can rotate their own password — this is
    // the only admin-adjacent route allowed while
    // `mustChangePassword=true`, so callers stuck on the seeded
    // credential can complete the bootstrap. The handler itself
    // re-verifies the current password before persisting.
    preHandler: requireAuth(),
    handler: authController.changePassword,
  });
};

export default authRoute;
