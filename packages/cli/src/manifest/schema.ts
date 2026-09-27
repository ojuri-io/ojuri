import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { error, type Finding } from "../findings";

/**
 * Path to the shipped schema. Resolved relative to this file so it works
 * both from `dist/manifest/` after a build and from `src/manifest/`
 * under ts-jest.
 */
export const SCHEMA_PATH = join(__dirname, "..", "..", "schema", "ojuri.v1.json");

let compiled: ValidateFunction | null = null;

export function schemaValidator(): ValidateFunction {
  if (compiled) return compiled;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  compiled = ajv.compile(schema);
  return compiled;
}

/** Test-only. Drops the memoised validator so a spec can reload the schema. */
export function _resetValidatorForTests(): void {
  compiled = null;
}

export function validateAgainstSchema(document: unknown): Finding[] {
  const validate = schemaValidator();
  if (validate(document)) return [];
  const errors = validate.errors ?? [];
  // `if` errors only say that a conditional branch was taken; the
  // branch's own error is already in the list and says something useful.
  return errors.filter((e) => e.keyword !== "if").map(toFinding);
}

function toFinding(err: ErrorObject): Finding {
  const path = dotted(err.instancePath);
  return error("schema", path === "" ? "(root)" : path, message(err), detail(err));
}

function dotted(instancePath: string): string {
  return instancePath.replace(/^\//, "").split("/").filter(Boolean).join(".");
}

function message(err: ErrorObject): string {
  const params = err.params as Record<string, unknown>;

  switch (err.keyword) {
    case "additionalProperties":
      return `Unknown field "${String(params.additionalProperty)}".`;
    case "required":
      return `Missing required field "${String(params.missingProperty)}".`;
    case "enum": {
      const allowed = (params.allowedValues as unknown[] | undefined) ?? [];
      return `Must be one of: ${allowed.map((v) => JSON.stringify(v)).join(", ")}.`;
    }
    case "const":
      return `Must be ${JSON.stringify(params.allowedValue)}.`;
    case "type":
      return `Must be of type ${String(params.type)}.`;
    case "minimum":
      return `Must be at least ${String(params.limit)}.`;
    case "maximum":
      return `Must be at most ${String(params.limit)}.`;
    case "minLength":
      return `Must not be empty.`;
    case "pattern":
      return `Does not match the expected format.`;
    case "false schema":
      return `This field is not valid here.`;
    default:
      return err.message ? `${err.message}.` : "Invalid value.";
  }
}

function detail(err: ErrorObject): string | undefined {
  const params = err.params as Record<string, unknown>;

  if (err.keyword === "false schema") {
    return (
      "Connection fields only apply when the datastore's mode is external. " +
      "With mode: bundled the stack runs its own container and takes its " +
      "settings from the compose file."
    );
  }
  if (err.keyword === "additionalProperties") {
    return "Check the spelling against packages/cli/schema/ojuri.v1.json.";
  }
  if (err.keyword === "pattern" && typeof params.pattern === "string") {
    return `Expected pattern: ${params.pattern}`;
  }
  return undefined;
}
