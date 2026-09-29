import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TEMPLATE_MANIFEST } from "../manifest/template";
import { locateStack } from "../stack/locate";
import { PACKAGE_DIR } from "../stack/package-dir";
import { readEnvValue, replaceUrlPassword, setEnvValue } from "../envfile";
import { DEFAULT_MANIFEST_FILENAME } from "../manifest/load";
import {
  generateAdminPassword,
  generateJwtSecret,
  generatePostgresPassword,
  generateServiceToken,
} from "../secrets";

export interface InitOptions {
  /** Overrides where the bundled .env.example is read from. */
  stackDir?: string;
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
 * A checkout has .env.example beside the manifest; a published package carries
 * it in the bundled stack. Preferring the local copy lets an operator edit it.
 */
function resolveEnvExample(dir: string, stackDir?: string): string | null {
  const local = join(dir, ".env.example");
  if (existsSync(local)) return local;

  const source = stackDir ? { root: stackDir, bundled: true } : locateStack(PACKAGE_DIR, dir);
  if (!source) return null;

  const bundled = join(source.root, ".env.example");
  return existsSync(bundled) ? bundled : null;
}

export { TEMPLATE_MANIFEST } from "../manifest/template";

export function init(options: InitOptions = {}): InitResult {
  const dir = resolve(options.dir ?? process.cwd());
  const manifestPath = join(dir, DEFAULT_MANIFEST_FILENAME);
  const envPath = join(dir, ".env");
  const examplePath = resolveEnvExample(dir, options.stackDir);

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

  if (examplePath === null) {
    result.ok = false;
    result.errors.push(
      "No .env.example to copy .env from, and none bundled with this package. " +
        "Run this from a checkout, or reinstall the package."
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

/** Swap the development defaults for generated values. */
function harden(text: string, adminPassword: string): string {
  let out = text;

  out = setEnvValue(out, "AUTH_JWT_SECRET", generateJwtSecret());
  out = setEnvValue(out, "ADMIN_SEED_PASSWORD", adminPassword);

  // MLA is on by default, and .env.example's token is a published
  // string over RDA's 32-character floor, so leaving it would ship a
  // working credential for models:register and models:set_status.
  out = setEnvValue(out, "MLA_SERVICE_TOKEN", generateServiceToken());

  // Grafana publishes 3001 on every interface and its admin can add a
  // datasource, so admin/admin is not a password to ship either.
  out = setEnvValue(out, "GRAFANA_PASSWORD", generateAdminPassword());

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
