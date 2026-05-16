import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import UserRepo from "@shared/authz/repositories/user.repo";
import AuthService from "@shared/authz/auth.service";
import { ErrorResponse } from "@shared/utils/response.util";

/**
 * Fastify pre-handler that rejects any request whose authenticated
 * subject still has `mustChangePassword=true`. Mounted onto the admin
 * route plug so every privileged endpoint is gated; the user can only
 * reach `/auth/login`, `/auth/me`, and `/auth/change-password` until
 * the rotation is completed.
 *
 * Plugin-level hooks fire before route-level `preHandler`, so this
 * hook can't rely on `req.auth` being populated by `requireAuth`. It
 * does its own bearer-token extraction + verify and bails silently
 * (lets `requireAuth` produce the 401) when the token is absent or
 * invalid. When the token is valid AND the user is flagged, it short-
 * circuits with 423 Locked and a stable `code` so the frontend can
 * distinguish this gate from a plain 401.
 */
export async function denyIfPasswordRotation(req: FastifyRequest, res: FastifyReply) {
  const header = req.headers.authorization as string | undefined;
  const token = extractBearer(header);
  if (!token) return; // let requireAuth produce the 401

  const auth = container.resolve(AuthService);
  const subject = auth.verifyToken(token);
  if (!subject) return; // ditto — let requireAuth reject

  const users = container.resolve(UserRepo);
  const row = await users.findById(subject.userId);
  if (row?.mustChangePassword) {
    return res.code(423).send({
      ...ErrorResponse("Password rotation required before accessing this resource"),
      code: "PASSWORD_ROTATION_REQUIRED",
    });
  }
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const parts = header.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return undefined;
}
