import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readEnvValue, replaceUrlPassword, setEnvValue } from "../envfile";
import { DEFAULT_MANIFEST_FILENAME } from "../manifest/load";
import {
  generateAdminPassword,
  generateJwtSecret,
  generatePostgresPassword,
} from "../secrets";

export interface InitOptions {
  /** Project directory. Defaults to the current working directory. */
  dir?: string;
  /** Keep the development defaults instead of generating secrets. */
  keepDevDefaults?: boolean;
}

export interface InitResult {
  ok: boolean;
  manifestPath: string;
  envPath: string;
  wroteManifest: boolean;
  wroteEnv: boolean;
  /** Generated admin password, when this run created the .env. */
  adminPassword?: string;
  messages: string[];
  errors: string[];
}

/**
 * Path to the default manifest shipped with the package, resolved
 * relative to this file so it works from `dist/commands/` after a build
 * and from `src/commands/` under ts-jest.
 */
export const TEMPLATE_MANIFEST = join(__dirname, "..", "..", "templates", "ojuri.yaml");

export function init(options: InitOptions = {}): InitResult {
  const dir = resolve(options.dir ?? process.cwd());
  const manifestPath = join(dir, DEFAULT_MANIFEST_FILENAME);
  const envPath = join(dir, ".env");
  const examplePath = join(dir, ".env.example");

  const result: InitResult = {
    ok: true,
    manifestPath,
    envPath,
    wroteManifest: false,
    wroteEnv: false,
    messages: [],
    errors: [],
  };

  // Refuse to overwrite either file. Both hold values an operator may
  // have edited, and a silent clobber of a .env is a lost afternoon.
  if (existsSync(manifestPath)) {
    result.messages.push(`${DEFAULT_MANIFEST_FILENAME} already exists, left alone.`);
  } else {
    writeFileSync(manifestPath, readFileSync(TEMPLATE_MANIFEST, "utf8"), "utf8");
    result.wroteManifest = true;
    result.messages.push(`Wrote ${DEFAULT_MANIFEST_FILENAME}.`);
  }

  if (existsSync(envPath)) {
    result.messages.push(".env already exists, left alone.");
    return result;
  }

  if (!existsSync(examplePath)) {
    result.ok = false;
    result.errors.push(
      `No .env.example in ${dir}, so there is nothing to copy .env from. ` +
        "Run this from the repository root."
    );
    return result;
  }

  copyFileSync(examplePath, envPath);
  result.wroteEnv = true;

  if (options.keepDevDefaults) {
    result.messages.push("Copied .env.example to .env, development defaults kept.");
    return result;
  }

  const adminPassword = generateAdminPassword();
  writeFileSync(envPath, harden(readFileSync(envPath, "utf8"), adminPassword), "utf8");
  result.adminPassword = adminPassword;
  result.messages.push("Copied .env.example to .env and generated fresh secrets.");
  return result;
}

/**
 * Swap the development defaults for generated values.
 *
 * MLA_SERVICE_TOKEN also ships a development default, but it is left
 * alone deliberately: it is out of scope for this change and noted for
 * a separate hardening pass.
 */
function harden(text: string, adminPassword: string): string {
  let out = text;

  out = setEnvValue(out, "AUTH_JWT_SECRET", generateJwtSecret());
  out = setEnvValue(out, "ADMIN_SEED_PASSWORD", adminPassword);

  // POSTGRES_PASSWORD is what the container takes; DB_PASSWORD and the
  // password inside DB_URL are what host-side tooling uses. All three
  // have to move together or `npm run db:migrate` stops matching the
  // database it just started.
  const postgresPassword = generatePostgresPassword();
  out = setEnvValue(out, "POSTGRES_PASSWORD", postgresPassword);
  out = setEnvValue(out, "DB_PASSWORD", postgresPassword);

  const dbUrl = readEnvValue(out, "DB_URL");
  if (dbUrl) out = setEnvValue(out, "DB_URL", replaceUrlPassword(dbUrl, postgresPassword));

  return out;
}
