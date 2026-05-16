import { FastifyReply, FastifyRequest } from "fastify";
import httpStatus from "http-status";
import { injectable } from "tsyringe";
import UserService, { ConflictError, NotFoundError } from "@shared/authz/user.service";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import {
  CreateUserDto,
  UpdateUserDto,
  AssignRoleDto,
} from "../dtos/user.dto";

@injectable()
class UsersController {
  constructor(private readonly users: UserService) {}

  list = async (
    req: FastifyRequest<{
      Querystring: { tenantId?: string; search?: string; limit?: string; offset?: string };
    }>,
    res: FastifyReply
  ) => {
    const result = await this.users.list({
      tenantId: req.query.tenantId,
      search: req.query.search,
      limit: req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined,
      offset: req.query.offset ? Number.parseInt(req.query.offset, 10) : undefined,
    });
    return res.send(SuccessResponse("Users", result));
  };

  get = async (req: FastifyRequest<{ Params: { id: string } }>, res: FastifyReply) => {
    const row = await this.users.get(req.params.id);
    if (!row) return res.code(httpStatus.NOT_FOUND).send(ErrorResponse("User not found"));
    return res.send(SuccessResponse("User", row));
  };

  create = async (req: FastifyRequest<{ Body: CreateUserDto }>, res: FastifyReply) => {
    try {
      const row = await this.users.create({
        ...req.body,
        createdBy: req.auth?.username,
      });
      return res.code(httpStatus.CREATED).send(SuccessResponse("User created", row));
    } catch (err) {
      return mapError(err, res);
    }
  };

  update = async (
    req: FastifyRequest<{ Params: { id: string }; Body: UpdateUserDto }>,
    res: FastifyReply
  ) => {
    try {
      const row = await this.users.update(req.params.id, req.body);
      return res.send(SuccessResponse("User updated", row));
    } catch (err) {
      return mapError(err, res);
    }
  };

  delete = async (req: FastifyRequest<{ Params: { id: string } }>, res: FastifyReply) => {
    try {
      await this.users.delete(req.params.id, req.auth?.userId);
      return res.send(SuccessResponse("User deleted"));
    } catch (err) {
      return mapError(err, res);
    }
  };

  assignRole = async (
    req: FastifyRequest<{ Params: { id: string }; Body: AssignRoleDto }>,
    res: FastifyReply
  ) => {
    try {
      const row = await this.users.assignRole(req.params.id, req.body.roleId, req.auth?.username);
      return res.send(SuccessResponse("Role assigned", row));
    } catch (err) {
      return mapError(err, res);
    }
  };

  unassignRole = async (
    req: FastifyRequest<{ Params: { id: string; roleId: string } }>,
    res: FastifyReply
  ) => {
    try {
      const row = await this.users.unassignRole(req.params.id, req.params.roleId);
      return res.send(SuccessResponse("Role removed", row));
    } catch (err) {
      return mapError(err, res);
    }
  };
}

function mapError(err: unknown, res: FastifyReply) {
  if (err instanceof NotFoundError) {
    return res.code(httpStatus.NOT_FOUND).send(ErrorResponse(err.message));
  }
  if (err instanceof ConflictError) {
    return res.code(httpStatus.CONFLICT).send(ErrorResponse(err.message));
  }
  throw err;
}

export default UsersController;
