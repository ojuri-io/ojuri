import { COMPOSE_FILE, COMPOSE_FILE_GHCR, ENV_FILENAME, OVERLAY_FILENAME } from "./compose-base";
import type { RenderPlan } from "./plan";

export interface CommandOptions {
  /** Build from source instead of pulling the published images. */
  build: boolean;
  /** Directory the rendered files were written to, relative to the project. */
  outDir: string;
  /** The adopter's own .env, passed first so the rendered one wins. */
  envFile?: string;
  /** Trailing arguments, e.g. ["up", "-d"]. */
  args?: string[];
}

/**
 * The exact Compose invocation this manifest implies. `ojuri up` runs
 * it and `--print-command` prints it, so what an adopter is told is
 * what actually runs.
 *
 * Compose reads repeated --env-file in order with the last winning, so
 * the adopter's .env supplies everything and the rendered file
 * overrides only the fields the manifest controls.
 */
export function composeCommand(plan: RenderPlan, opts: CommandOptions): string[] {
  const argv = ["docker", "compose"];

  if (opts.envFile) argv.push("--env-file", opts.envFile);
  argv.push("--env-file", join(opts.outDir, ENV_FILENAME));

  argv.push("-f", COMPOSE_FILE);
  // The GHCR overlay only swaps `build:` for `image:`. Building from
  // source means leaving it out entirely.
  if (!opts.build) argv.push("-f", COMPOSE_FILE_GHCR);
  argv.push("-f", join(opts.outDir, OVERLAY_FILENAME));

  for (const profile of plan.profiles) argv.push("--profile", profile);

  if (opts.args) argv.push(...opts.args);
  return argv;
}

/** Shell-ready rendering of the command, for printing. */
export function formatCommand(argv: string[]): string {
  return argv.map(quote).join(" ");
}

function quote(arg: string): string {
  return /^[A-Za-z0-9_./:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

function join(dir: string, file: string): string {
  const trimmed = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return trimmed === "" || trimmed === "." ? file : `${trimmed}/${file}`;
}
