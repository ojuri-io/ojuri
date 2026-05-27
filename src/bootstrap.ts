import cors, { FastifyCorsOptions } from "@fastify/cors";
import AppError from "@shared/error/app.error";
import Logger from "@shared/utils/logger";
import loggerPlugin from "@shared/utils/logger/plugin";
import { ErrorResponse } from "@shared/utils/response.util";
import initializeDatabase from "./database";
import { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import Validator from "validatorjs";
import "./shared/subscribers/audit-log.subscriber";

function bootstrapApp(fastify: FastifyInstance) {
  registerThirdPartyModules(fastify);

  initializeDatabase();

  registerCustomValidationRules();

  setErrorHandler(fastify);
}

function registerThirdPartyModules(fastify: FastifyInstance) {
  fastify.register(cors, buildCorsOptions());

  fastify.register(loggerPlugin);
}

function buildCorsOptions(): FastifyCorsOptions {
  const raw = process.env.SENTINEL_CORS_ORIGINS ?? "";
  const configured = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const allowlist = configured.length > 0
    ? configured
    : ["http://localhost:5173", "http://localhost:3000"];

  return {
    origin: (origin, cb) => {
      // No-Origin = same-origin or non-browser caller — allow through.
      // "null" = file://, sandboxed iframe, redirect chain — refuse.
      if (!origin) return cb(null, true);
      if (origin === "null") return cb(null, false);
      cb(null, allowlist.includes(origin));
    },
    credentials: true,
  };
}

function registerCustomValidationRules() {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  Validator.register(
    "password",
    (value) => /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[@#$%^&+=!])(?!.*\s).{8,}$/.test(String(value)),
    "The :attribute field must be at least 8 characters and must contain at least one uppercase, one lowercase, one digit, and one special character"
  );

  Validator.register(
    "name",
    (value) => /^[a-zA-Z-]{2,50}$/.test(String(value)),
    "The :attribute field is not valid"
  );

  Validator.register(
    "cleanString",
    (value) => /^[a-zA-Z0-9_ -]{1,100}$/.test(String(value)),
    "The :attribute field is not valid. Please ensure it doesn't contain special characters and not more than 100 characters"
  );

  Validator.register(
    "username",
    (value) => /^[a-zA-Z-][a-zA-Z0-9_-]{1,20}$/.test(String(value)),
    "The :attribute field is not valid"
  );

  Validator.register(
    "uuid",
    (value) => uuidRegex.test(String(value)),
    ":attribute is not a valid UUID"
  );

  Validator.register(
    "phone",
    (value) => /^(?:(?:(?:\+?234(?:\s1)?|01)\s*)?(?:\(\d{3}\)|\d{3})|\d{4})(?:\W*\d{3})?\W*\d{4}$/.test(String(value)),
    "The :attribute field is not in the correct format. Example of allowed format is 2348888888888."
  );
}

function setErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((err: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const raw = err.statusCode;
    const statusCode = typeof raw === "number" && raw >= 400 && raw < 600 ? raw : 500;
    const message = err instanceof AppError
      ? err.message
      : "We are unable to process this request. Please try again.";

    Logger.error({ err: err.cause || err });

    return reply.status(statusCode).send(ErrorResponse(message));
  });
}

export default bootstrapApp;
