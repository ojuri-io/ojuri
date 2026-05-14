import { FastifyPluginAsync } from "fastify";
import { container } from "tsyringe";
import UsersController from "../controller/users.controller";
import validate from "@shared/middlewares/validator.middleware";
import { requireAuth } from "@shared/middlewares/require-auth.middleware";
import {
  createUserValidationRules,
  createUserValidationMessages,
  updateUserValidationRules,
  updateUserValidationMessages,
  assignRoleValidationRules,
  assignRoleValidationMessages,
} from "../validations/user.validator";

const usersController = container.resolve(UsersController);

const usersRoute: FastifyPluginAsync = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/admin/users",
    preHandler: [requireAuth("users:read")],
    handler: usersController.list,
  });

  fastify.route({
    method: "GET",
    url: "/admin/users/:id",
    preHandler: [requireAuth("users:read")],
    handler: usersController.get,
  });

  fastify.route({
    method: "POST",
    url: "/admin/users",
    preHandler: [
      requireAuth("users:create"),
      validate(createUserValidationRules, createUserValidationMessages),
    ],
    handler: usersController.create,
  });

  fastify.route({
    method: "PATCH",
    url: "/admin/users/:id",
    preHandler: [
      requireAuth("users:update"),
      validate(updateUserValidationRules, updateUserValidationMessages),
    ],
    handler: usersController.update,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/users/:id",
    preHandler: [requireAuth("users:delete")],
    handler: usersController.delete,
  });

  fastify.route({
    method: "POST",
    url: "/admin/users/:id/roles",
    preHandler: [
      requireAuth("users:update"),
      validate(assignRoleValidationRules, assignRoleValidationMessages),
    ],
    handler: usersController.assignRole,
  });

  fastify.route({
    method: "DELETE",
    url: "/admin/users/:id/roles/:roleId",
    preHandler: [requireAuth("users:update")],
    handler: usersController.unassignRole,
  });
};

export default usersRoute;
