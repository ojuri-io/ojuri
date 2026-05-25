import { FastifyReply, FastifyRequest } from "fastify";
import Validator from "validatorjs";
import { ErrorResponse } from "../utils/response.util";
import { ObjectLiteral } from "../types/object-literal.type";

type Error = {
  field: string;
  message: string;
};

const validate = (rules: ObjectLiteral, validationMessages?: ObjectLiteral) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const validation = new Validator(request.body || request.query, rules, validationMessages);

    if (validation.fails()) {
      // Explicit return — Fastify currently short-circuits when reply.send
      // is called in a preHandler, but the function as written falls
      // through. A future major upgrade or refactor could silently let
      // the next handler run on a 400'd request.
      return reply
        .code(400)
        .send(ErrorResponse("Your data is invalid", createValidationError(validation.errors.all())));
    }
  };
};

export const createValidationError = (validationError: []) => {
  const errors: Error[] = [];

  for (const [key, value] of Object.entries(validationError)) {
    errors.push({
      field: key,
      message: value[0],
    });
  }

  return errors;
};

export default validate;
