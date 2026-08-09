import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import AuthService from "@shared/authz/auth.service";
import { ErrorResponse } from "@shared/utils/response.util";

/**
 * Fastify pre-handler that rejects any request whose authenticated
 * subject still has `mustChangePassword=true`. Mounted onto the admin
 * route plug so every privileged endpoint is gated; the user can only
 * reach `/auth/login`, `/auth/me`, and `/auth/change-password` until
 * the rotation is completed.
 *
 * Reads `mustChangePassword` through `verifyTokenLive`, which overlays
 * the JWT with current database state (30 s cache shared with
 * `requireAuth`, so the two hooks cost one DB read per user per TTL).
 * An admin-forced rotation therefore locks the target's session within
 * the cache TTL instead of waiting for their next login.
 *
 * Plugin-level hooks fire before route-level `preHandler`, so this
 * hook can't rely on `req.auth` being populated by `requireAuth`. It
 * does its own bearer-token extraction + verify and bails silently
 * (lets `requireAuth` produce the 401) when the token is absent or
 * invalid. When the token is valid AND the flag is set, it short-
 * circuits with 423 Locked and a stable `code` so the frontend can
 * distinguish this gate from a plain 401.
 */
export async function denyIfPasswordRotation(req: FastifyRequest, res: FastifyReply) {
  const header = req.headers.authorization as string | undefined;
  const token = extractBearer(header);
  if (!token) return; // let requireAuth produce the 401

  const auth = container.resolve(AuthService);
  const subject = await auth.verifyTokenLive(token);
  if (!subject) return; // ditto — let requireAuth reject

  if (subject.mustChangePassword) {
    return res.code(423).send({
      ...ErrorResponse("Password rotation required before accessing this resource"),
      code: "PASSWORD_ROTATION_REQUIRED",
    });
  }
}

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer (\S+)$/i);
  return match ? match[1] : undefined;
}
