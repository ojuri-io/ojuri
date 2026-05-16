import { FastifyPluginAsync } from "fastify";
import apiKeysRoute from "./api-keys.route";
import webhooksRoute from "./webhooks.route";
import modelsRoute from "./models.route";
import rulesRoute from "./rules.route";
import usersRoute from "./users.route";
import rolesRoute from "./roles.route";
import auditRoute from "./audit.route";
import savedReportsRoute from "./saved-reports.route";
import featuresRoute from "./features.route";
import settingsRoute from "./settings.route";
import { denyIfPasswordRotation } from "@shared/middlewares/deny-if-password-rotation.middleware";

/**
 * Admin / management routes.
 *
 * Each sub-route owns its own `requireAuth(...)` pre-handler with the
 * permission code it needs. There is no shared "admin token" anymore —
 * the previous static `RDA_ADMIN_TOKEN` gate was retired in favour of
 * per-permission checks against the seeded user/role tables. Bootstrap
 * by logging in as `admin / admin@fraudit` (see docs/AUTHZ.md) and
 * issuing real users + roles from there.
 */
const adminRoute: FastifyPluginAsync = async (fastify) => {
  // Block every admin endpoint while the authenticated user still owes
  // a forced password rotation (mustChangePassword=true). Runs after
  // each sub-route's own requireAuth, so `req.auth` is populated.
  fastify.addHook("preHandler", denyIfPasswordRotation);
  fastify.register(apiKeysRoute);
  fastify.register(webhooksRoute);
  fastify.register(modelsRoute);
  fastify.register(rulesRoute);
  fastify.register(usersRoute);
  fastify.register(rolesRoute);
  fastify.register(auditRoute);
  fastify.register(savedReportsRoute);
  fastify.register(featuresRoute);
  fastify.register(settingsRoute);
};

export default adminRoute;
