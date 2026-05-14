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
  fastify.register(apiKeysRoute);
  fastify.register(webhooksRoute);
  fastify.register(modelsRoute);
  fastify.register(rulesRoute);
  fastify.register(usersRoute);
  fastify.register(rolesRoute);
  fastify.register(auditRoute);
  fastify.register(savedReportsRoute);
  fastify.register(featuresRoute);
};

export default adminRoute;
