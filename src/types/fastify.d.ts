// src/types/fastify.d.ts

import { FastifyRequest } from "fastify";
import { UserToken } from "../v1/modules/auth/dtos/user.token.dto";

declare module "fastify" {
  interface FastifyRequest {
    user: UserToken;
  }
}
