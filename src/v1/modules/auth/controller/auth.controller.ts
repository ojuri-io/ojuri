import { FastifyReply, FastifyRequest } from "fastify";
import httpStatus from "http-status";
import { injectable } from "tsyringe";
import AuthService, { InvalidCredentialsError, AuthConfigError } from "@shared/authz/auth.service";
import UserRepo from "@shared/authz/repositories/user.repo";
import { ErrorResponse, SuccessResponse } from "@shared/utils/response.util";

export interface LoginDto {
  username: string;
  password: string;
  tenantId?: string;
}

@injectable()
class AuthController {
  constructor(private readonly authService: AuthService, private readonly users: UserRepo) {}

  login = async (req: FastifyRequest<{ Body: LoginDto }>, res: FastifyReply) => {
    try {
      const result = await this.authService.login(req.body);
      return res.send(SuccessResponse("Logged in", result));
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse(err.message));
      }
      if (err instanceof AuthConfigError) {
        return res.code(httpStatus.SERVICE_UNAVAILABLE).send(ErrorResponse(err.message));
      }
      throw err;
    }
  };

  // Stateless JWT — logout is a client-side concern (drop the token).
  // The endpoint exists so dashboards can call it without a 404 and so
  // we have a clean hook if we ever introduce a server-side revocation
  // list.
  logout = async (_req: FastifyRequest, res: FastifyReply) => {
    return res.send(SuccessResponse("Logged out"));
  };

  me = async (req: FastifyRequest, res: FastifyReply) => {
    // `requireAuth()` populates `req.auth`; this handler is only mounted
    // behind it, so a missing `auth` here is a programming error.
    const subject = req.auth;
    if (!subject) {
      return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse("Not authenticated"));
    }

    const detail = await this.users.findByIdWithRoles(subject.userId);
    if (!detail) {
      return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse("User no longer exists"));
    }

    return res.send(
      SuccessResponse("Current user", {
        id: detail.id,
        username: detail.username,
        fullName: detail.fullName,
        email: detail.email,
        tenantId: detail.tenantId,
        isActive: detail.isActive,
        roles: detail.roles.map((r) => ({ id: r.id, name: r.name })),
        permissions: subject.permissions,
      })
    );
  };
}

export default AuthController;
