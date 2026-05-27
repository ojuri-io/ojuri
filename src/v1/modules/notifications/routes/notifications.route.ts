import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import NotificationsController from "../controller/notifications.controller";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";

const notificationsController = container.resolve(NotificationsController);

const notificationsRoute: FastifyPluginAsync = async (fastify) => {
  // Any authenticated user can clear their own bell — no permission
  // catalogue entry needed since this is a personal-state mutation.
  fastify.route({
    method: "POST",
    url: "/notifications/seen",
    preHandler: requireAuth(),
    handler: notificationsController.seen,
  });
};

export default notificationsRoute;
