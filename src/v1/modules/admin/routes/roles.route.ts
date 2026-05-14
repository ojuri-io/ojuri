import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import RolesController from "../controller/roles.controller";
import validate from "@shared/middlewares/validator.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import {
  createRoleValidationRules,
  createRoleValidationMessages,
  updateRoleValidationRules,
  updateRoleValidationMessages,
} from "../validations/role.validator";

const rolesController = container.resolve(RolesController);

const rolesRoute: FastifyPluginAsync = async (fastify) => {
  // Permission catalogue. The UI role editor reads this to build the
  // picker — no auth required beyond "logged in" so non-admins can see
  // what the system supports.
  fastify.route({
    method: "GET",
    url: "/admin/permissions",
    preHandler: [requireAuth()],
    handler: rolesController.listPermissions,
  });

  fastify.route({
    method: "GET",
    url: "/admin/roles",
    preHandler: [requireAuth("roles:read")],
    handler: rolesController.list,
  });

  fastify.route({
    method: "POST",
    url: "/admin/roles",
    preHandler: [
      requireAuth("roles:create"),
      validate(createRoleValidationRules, createRoleValidationMessages),
    ],
    handler: rolesController.create,
  });

  fastify.route({
    method: "PATCH",
    url: "/admin/roles/:id",
    preHandler: [
      requireAuth("roles:update"),
      validate(updateRoleValidationRules, updateRoleValidationMessages),
    ],
    handler: rolesController.update,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/roles/:id",
    preHandler: [requireAuth("roles:delete")],
    handler: rolesController.delete,
  });
};

export default rolesRoute;
