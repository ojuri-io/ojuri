import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { error, type Finding } from "../findings";
import { loadDotenv, resolveReferences, type EnvSource } from "./env";
import type { Manifest } from "./types";

export const DEFAULT_MANIFEST_FILENAME = "ojuri.yaml";

export interface LoadedManifest {
  /** Absolute path the manifest was read from. */
  path: string;
  /** Parsed and reference-resolved document, or null when it could not be read. */
  manifest: Manifest | null;
  env: EnvSource;
  /** Populated when the file is missing or unparseable; `manifest` is null then. */
  findings: Finding[];
}

/**
 * Read a manifest and resolve its `${VAR}` references. The `.env` file
 * is looked for beside the manifest, which is where Compose looks too.
 */
export function loadManifest(
  path: string,
  processEnv: Record<string, string | undefined> = process.env
): LoadedManifest {
  const absolute = resolve(path);
  const env: EnvSource = {
    dotenv: loadDotenv(resolve(dirname(absolute), ".env")),
    process: processEnv,
  };

  if (!existsSync(absolute)) {
    return {
      path: absolute,
      manifest: null,
      env,
      findings: [
        error(
          "missing-manifest",
          "",
          "No manifest found at this path.",
          "Run `ojuri init` to write a default ojuri.yaml, or pass the path " +
            "to an existing one."
        ),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(absolute, "utf8"));
  } catch (err) {
    return {
      path: absolute,
      manifest: null,
      env,
      findings: [
        error(
          "unparseable-manifest",
          "",
          "The manifest is not valid YAML.",
          err instanceof Error ? err.message : String(err)
        ),
      ],
    };
  }

  if (parsed === null || parsed === undefined) {
    return {
      path: absolute,
      manifest: null,
      env,
      findings: [error("empty-manifest", "", "The manifest is empty.")],
    };
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      path: absolute,
      manifest: null,
      env,
      findings: [
        error("unparseable-manifest", "", "The manifest must be a YAML mapping at the top level."),
      ],
    };
  }

  const { value } = resolveReferences(parsed as Manifest, env);
  return { path: absolute, manifest: value, env, findings: [] };
}
