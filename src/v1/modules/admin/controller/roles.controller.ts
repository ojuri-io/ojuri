import { FastifyReply, FastifyRequest } from "fastify";
import httpStatus from "http-status";
import { injectable } from "tsyringe";
import RoleService from "@shared/authz/role.service";
import { ConflictError, NotFoundError } from "@shared/authz/user.service";
import { PERMISSIONS } from "@shared/authz/permissions";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";
import { CreateRoleDto, UpdateRoleDto } from "../dtos/role.dto";

@injectable()
class RolesController {
  constructor(private readonly roles: RoleService) {}

  listPermissions = async (_req: FastifyRequest, res: FastifyReply) => {
    return res.send(SuccessResponse("Permissions", PERMISSIONS));
  };

  list = async (req: FastifyRequest<{ Querystring: { tenantId?: string } }>, res: FastifyReply) => {
    const rows = await this.roles.list(req.query.tenantId);
    return res.send(SuccessResponse("Roles", rows));
  };

  create = async (req: FastifyRequest<{ Body: CreateRoleDto }>, res: FastifyReply) => {
    try {
      const row = await this.roles.create(req.body);
      return res.code(httpStatus.CREATED).send(SuccessResponse("Role created", row));
    } catch (err) {
      return mapError(err, res);
    }
  };

  update = async (
    req: FastifyRequest<{ Params: { id: string }; Body: UpdateRoleDto }>,
    res: FastifyReply
  ) => {
    try {
      const row = await this.roles.update(req.params.id, req.body);
      return res.send(SuccessResponse("Role updated", row));
    } catch (err) {
      return mapError(err, res);
    }
  };

  delete = async (req: FastifyRequest<{ Params: { id: string } }>, res: FastifyReply) => {
    try {
      await this.roles.delete(req.params.id);
      return res.send(SuccessResponse("Role deleted"));
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

export default RolesController;
