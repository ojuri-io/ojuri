import cors from "@fastify/cors";
import AppError from "@shared/error/app.error";
import Logger from "@shared/utils/logger";
import loggerPlugin from "@shared/utils/logger/plugin";
import { ErrorResponse } from "@shared/utils/response.util";
import initializeDatabase from "./database";
import { FastifyInstance } from "fastify";
import multer from "fastify-multer";

import Validator from "validatorjs";
import "./shared/subscribers/audit-log.subscriber";

function bootstrapApp(fastify: FastifyInstance) {
  registerThirdPartyModules(fastify);

  initializeDatabase();

  registerCustomValidationRules();

  setErrorHandler(fastify);

  registerFileHandler(fastify);
}

function registerThirdPartyModules(fastify) {
  fastify.register(cors, { origin: true });

  fastify.register(loggerPlugin);
}

function registerCustomValidationRules() {
  // initialize custom validations for validatorjs
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  Validator.register(
    "password",
    (value: string) => {
      return /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[@#$%^&+=!])(?!.*\s).{8,}$/.test(value);
    },
    "The :attribute field must be at least 8 characters and must contain at least one uppercase, one lowercase, one digit, and one special character"
  );

  Validator.register(
    "name",
    (value) => {
      return /^[a-zA-Z-]{2,50}$/.test(value);
    },
    "The :attribute field is not valid"
  );

  Validator.register(
    "cleanString",
    (value) => {
      return /^[a-zA-Z0-9_ -]{1,100}$/.test(value);
    },
    "The :attribute field is not valid. Please ensure it doesn't contain special characters and not more than 100 characters"
  );

  Validator.register(
    "username",
    (value) => {
      return /^[a-zA-Z-][a-zA-Z0-9_-]{1,20}$/.test(value);
    },
    "The :attribute field is not valid"
  );

  Validator.register(
    "uuid",
    (value) => {
      return uuidRegex.test(value);
    },
    ":attribute is not a valid UUID"
  );

  Validator.register(
    "phone",
    (value: any) => {
      return value.match(/^(?:(?:(?:\+?234(?:\h1)?|01)\h*)?(?:\(\d{3}\)|\d{3})|\d{4})(?:\W*\d{3})?\W*\d{4}$/);
    },
    "The :attribute field is not in the correct format. Example of allowed format is 2348888888888."
  );

  Validator.register(
    "amount",
    (value: any) => {
      return !Number.isSafeInteger(value);
    },
    "The :attribute field is invalid"
  );
}

function registerFileHandler(fastify: FastifyInstance) {
  fastify.register(multer.contentParser);
}

function setErrorHandler(fastify) {
  fastify.setErrorHandler((err, request, reply) => {
    const statusCode = err.statusCode || 503;
    const message = err instanceof AppError ? err.message : "We are unable to proces this request. Please try again.";

    Logger.error({ err: err.cause || err });

    return reply.status(statusCode).send(ErrorResponse(message));
  });
}

export default bootstrapApp;
