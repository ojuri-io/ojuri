import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { countBySeverity, error, type Finding } from "../findings";
import { loadManifest } from "../manifest/load";
import { applyRules } from "../manifest/rules";
import { validateAgainstSchema } from "../manifest/schema";
import { composeCommand, formatCommand, type CommandOptions } from "./command";
import { ENV_FILENAME, OVERLAY_FILENAME } from "./compose-base";
import { renderEnvFile } from "./env-file";
import { isNoOp, renderOverlay } from "./overlay";
import { buildPlan, type RenderPlan } from "./plan";

export const DEFAULT_OUT_DIR = ".ojuri";

export interface RenderOptions {
  outDir?: string;
  build?: boolean;
  /** Work out the files without writing them. */
  dryRun?: boolean;
  processEnv?: Record<string, string | undefined>;
}

export interface RenderResult {
  manifestPath: string;
  plan: RenderPlan | null;
  findings: Finding[];
  ok: boolean;
  /** Absolute paths of the files written, empty on a dry run or a failure. */
  written: string[];
  envFileContent: string;
  overlayContent: string;
  command: string;
  noOp: boolean;
}

/**
 * Validate, then turn the manifest into a `.env` fragment and a Compose
 * overlay. Rendering a manifest that does not validate is refused: a
 * rendered stack built on a manifest with errors is worse than no
 * stack, because it looks like it worked.
 */
export function render(manifestPath: string, options: RenderOptions = {}): RenderResult {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const loaded = loadManifest(manifestPath, options.processEnv ?? process.env);

  const empty = {
    manifestPath: loaded.path,
    plan: null,
    written: [],
    envFileContent: "",
    overlayContent: "",
    command: "",
    noOp: false,
  };

  if (loaded.manifest === null) {
    return { ...empty, findings: loaded.findings, ok: false };
  }

  const schemaFindings = validateAgainstSchema(loaded.manifest);
  if (schemaFindings.length > 0) {
    return { ...empty, findings: schemaFindings, ok: false };
  }

  const findings = applyRules(loaded.manifest, loaded.env);
  if (countBySeverity(findings).errors > 0) {
    return { ...empty, findings, ok: false };
  }

  const plan = buildPlan(loaded.manifest);
  const envFileContent = renderEnvFile(plan);
  const overlayContent = renderOverlay(plan);

  const projectDir = dirname(loaded.path);
  const commandOptions: CommandOptions = {
    build: options.build === true,
    outDir,
    envFile: ".env",
    args: ["up", "-d"],
  };
  const command = formatCommand(composeCommand(plan, commandOptions));

  const result: RenderResult = {
    manifestPath: loaded.path,
    plan,
    findings,
    ok: true,
    written: [],
    envFileContent,
    overlayContent,
    command,
    noOp: isNoOp(plan.overlay),
  };

  if (options.dryRun) return result;

  const absoluteOutDir = resolve(projectDir, outDir);
  try {
    mkdirSync(absoluteOutDir, { recursive: true });
    const envPath = join(absoluteOutDir, ENV_FILENAME);
    const overlayPath = join(absoluteOutDir, OVERLAY_FILENAME);
    writeFileSync(envPath, envFileContent, "utf8");
    writeFileSync(overlayPath, overlayContent, "utf8");
    result.written = [envPath, overlayPath];
  } catch (err) {
    return {
      ...result,
      ok: false,
      written: [],
      findings: [
        ...findings,
        error(
          "write-failed",
          "",
          `Could not write to ${relative(projectDir, absoluteOutDir) || absoluteOutDir}.`,
          err instanceof Error ? err.message : String(err)
        ),
      ],
    };
  }

  return result;
}

export { buildPlan, composeCommand, formatCommand, renderEnvFile, renderOverlay, isNoOp };
export type { RenderPlan };
