import cors from "@fastify/cors";
import AppError from "@shared/error/app.error";
import Logger from "@shared/utils/logger";
import loggerPlugin from "@shared/utils/logger/plugin";
import { ErrorResponse } from "@shared/utils/response.util";
import initializeDatabase from "./database";
import { FastifyInstance } from "fastify";

import Validator from "validatorjs";
import "./shared/subscribers/audit-log.subscriber";

function bootstrapApp(fastify: FastifyInstance) {
  registerThirdPartyModules(fastify);

  initializeDatabase();

  registerCustomValidationRules();

  setErrorHandler(fastify);
}

function registerThirdPartyModules(fastify) {
  fastify.register(cors, buildCorsOptions());

  fastify.register(loggerPlugin);
}

/**
 * Build the CORS origin allowlist from `SENTINEL_CORS_ORIGINS`
 * (comma-separated). In development we accept the Sentinel dev server and
 * the local API by default. `Origin: null` is always rejected — `null`
 * is what file://, sandboxed iframes, and some redirect chains advertise,
 * and there's no benefit to allowing it for an admin/predict API.
 */
function buildCorsOptions() {
  const raw = process.env.SENTINEL_CORS_ORIGINS ?? "";
  const configured = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const allowlist = configured.length > 0
    ? configured
    : ["http://localhost:5173", "http://localhost:3000"];

  return {
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      // Same-origin / non-browser callers (curl, server-to-server) send no Origin.
      if (!origin) return cb(null, true);
      if (origin === "null") return cb(null, false);
      if (allowlist.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  };
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
      return value.match(/^(?:(?:(?:\+?234(?:\s1)?|01)\s*)?(?:\(\d{3}\)|\d{3})|\d{4})(?:\W*\d{3})?\W*\d{4}$/);
    },
    "The :attribute field is not in the correct format. Example of allowed format is 2348888888888."
  );

  // The custom "amount" rule isn't referenced by any validator today
  // (predict.validator.ts uses `numeric|min:0.01|max:9999999999`), and
  // the previous body was inverted (returned true for non-integers,
  // false for safe integers — which would have rejected every valid
  // amount). Removing rather than fixing because adding it to a rule
  // string with the wrong semantics would silently break input
  // validation across every payload that uses it.
}

function setErrorHandler(fastify) {
  fastify.setErrorHandler((err, request, reply) => {
    // Respect explicit 4xx status codes from validation / auth /
    // not-found errors. Default unknowns to 500 (not 503 — 503 means
    // "service unavailable, try later" and is the wrong semantic for
    // a generic uncaught error).
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
