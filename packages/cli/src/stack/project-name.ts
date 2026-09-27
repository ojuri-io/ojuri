import { basename, resolve } from "node:path";

const FALLBACK = "ojuri";

/**
 * Compose derives the project name from the project directory, which
 * `--project-directory` repoints at the materialised stack, so every install
 * would otherwise share the name `stack` and adopt each other's volumes.
 * Naming it after the working directory reproduces what a checkout gets today.
 */
export function projectNameFor(workingDir: string): string {
  const sanitised = basename(resolve(workingDir))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9]+/, "");
  return sanitised.length > 0 ? sanitised : FALLBACK;
}
