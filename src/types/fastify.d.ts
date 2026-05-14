// Fastify type augmentations.
//
// `req.auth` is set by `requireAuth(...)` in
// `src/shared/middlewares/require-auth.middleware.ts` and carries the
// decoded JWT subject for the current request. `req.apiKey` is set by
// the API-key middleware on /v1/predict. Neither is guaranteed to be
// present on every request, hence both are optional here.

import "fastify";
import type { AuthSubject } from "../shared/authz/auth.service";
import type { ApiKeyContext } from "../shared/auth/api-key.types";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthSubject;
    apiKey?: ApiKeyContext;
  }
}
