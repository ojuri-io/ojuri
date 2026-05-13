import { FastifyReply, FastifyRequest } from "fastify";
import httpStatus from "http-status";
import { container } from "tsyringe";
import ApiKeyService from "@shared/auth/api-key.service";
import { checkRate } from "@shared/auth/rate-limiter";
import { ErrorResponse } from "@shared/utils/response.util";

/**
 * Resolves the presented API key (header `X-Api-Key` or
 * `Authorization: Bearer fdk_...`) and attaches its context to the
 * request. Enforces the per-key rate limit. Rejects with 401 / 429
 * when appropriate.
 *
 * When `RDA_REQUIRE_API_KEY=false`, unauthenticated requests still
 * pass through with no `req.apiKey` set — useful for local dev or
 * for keeping prediction unauthenticated behind a private network
 * while the admin / management routes remain locked.
 */
export function apiKeyMiddleware(opts: { required: boolean }) {
  const apiKeyService = container.resolve(ApiKeyService);

  return async (req: FastifyRequest, res: FastifyReply) => {
    const token = extractToken(req);

    if (!token) {
      if (opts.required) {
        return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse("API key required"));
      }
      return;
    }

    const context = await apiKeyService.verify(token);
    if (!context) {
      return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse("Invalid API key"));
    }

    if (!checkRate(context.id, context.rateLimitPerMinute)) {
      return res.code(httpStatus.TOO_MANY_REQUESTS).send(ErrorResponse("Rate limit exceeded"));
    }

    req.apiKey = context;
  };
}

/**
 * Admin-only guard — gated by a shared static token configured via
 * `RDA_ADMIN_TOKEN`. Use sparingly: the admin token bypasses the
 * per-key rate limit and is intended for bootstrapping the first
 * API key, not for hot-path traffic.
 */
export function adminTokenMiddleware() {
  return async (req: FastifyRequest, res: FastifyReply) => {
    const expected = process.env.RDA_ADMIN_TOKEN;
    if (!expected) {
      return res.code(httpStatus.SERVICE_UNAVAILABLE).send(
        ErrorResponse("Admin API disabled: set RDA_ADMIN_TOKEN to enable")
      );
    }

    const presented =
      (req.headers["x-admin-token"] as string | undefined) ||
      extractBearer(req.headers.authorization as string | undefined);

    if (presented !== expected) {
      return res.code(httpStatus.UNAUTHORIZED).send(ErrorResponse("Admin token required"));
    }
  };
}

function extractToken(req: FastifyRequest): string | undefined {
  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.length > 0) {
    return headerKey;
  }
  return extractBearer(req.headers.authorization as string | undefined);
}

function extractBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return undefined;
}
