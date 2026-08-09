import { FastifyReply, FastifyRequest } from "fastify";
import httpStatus from "http-status";
import { container } from "tsyringe";
import AuthService from "@shared/authz/auth.service";
import { ErrorResponse } from "@shared/utils/response.util";

/**
 * Fastify pre-handler that verifies a JWT bearer token and enforces
 * that the subject holds at least one of the required permissions.
 *
 * Usage:
 *   fastify.addHook("preHandler", requireAuth("rules:read"));
 *   fastify.addHook("preHandler", requireAuth("rules:create", "rules:update"));
 *
 * Passing no permission codes means "must be logged in but any
 * authenticated subject is fine". Useful for `/v1/auth/me`.
 *
 * The wildcard `*` is granted only to the seeded SUPER_ADMIN role and
 * satisfies every required code. See `src/shared/authz/permissions.ts`.
 *
 * The JWT authenticates identity only. Permissions and `isActive` are
 * resolved from Postgres per request (30 s cache in AuthService), so
 * role edits and user deactivation apply mid-session rather than on
 * next login.
 */
export function requireAuth(...requiredPermissions: string[]) {
  const authService = container.resolve(AuthService);

  return async (req: FastifyRequest, res: FastifyReply) => {
    const token = extractBearer(req.headers.authorization as string | undefined);
    if (!token) {
      return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse("Authentication required"));
    }

    // Try the static service-token path first (cheap SHA-256 + timingSafeEqual);
    // fall through to JWT verification. MLA uses this path to register and
    // activate model versions without holding a refreshable JWT.
    const subject =
      authService.verifyServiceToken(token) ?? (await authService.verifyTokenLive(token));
    if (!subject) {
      return res
        .code(httpStatus.UNAUTHORIZED)
        .send(ErrorResponse("Invalid or expired token"));
    }

    if (!AuthService.hasPermission(subject, requiredPermissions)) {
      return res.code(httpStatus.FORBIDDEN).send(
        ErrorResponse(
          requiredPermissions.length === 1
            ? `Missing required permission: ${requiredPermissions[0]}`
            : `Missing required permission (one of: ${requiredPermissions.join(", ")})`
        )
      );
    }

    req.auth = subject;
  };
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  // Anchored regex tolerates only single-space separator and rejects
  // leading/trailing whitespace. The previous split(" ") accepted
  // "Bearer  token" (two spaces) which split to length 3 and silently
  // fell through to "no token".
  const match = header.match(/^Bearer (\S+)$/i);
  return match ? match[1] : undefined;
}
