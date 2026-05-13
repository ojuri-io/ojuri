import { FastifyReply } from "fastify";
import Validator from "validatorjs";
import httpStatus from "http-status";
import { ErrorResponse } from "../utils/response.util";
import { createValidationError } from "./validator.middleware";

const rules = {
  id: "required|uuid",
};

const validationMessages = {
  "uuid.id": "id should be a valid uuid",
};

const validateIdParam = (request: any, reply: FastifyReply, done) => {
  const validation = new Validator(request.params, rules, validationMessages);

  const errors = validation.errors.all();

  if (validation.fails()) {
    return reply.code(httpStatus.BAD_REQUEST).send(ErrorResponse("id is invalid", createValidationError(errors)));
  }

  done();
};
export default validateIdParam;
