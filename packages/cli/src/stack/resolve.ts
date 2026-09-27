import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { locateStack } from "./locate";
import { PACKAGE_DIR } from "./package-dir";
import { projectNameFor } from "./project-name";

export interface ResolvedStack {
  stackDir: string;
  projectName: string;
}

/**
 * Every command has to agree on both values: a different stackDir reads a
 * different compose file, and a different projectName addresses a different
 * set of containers, so `ojuri down` would miss what `ojuri up` started.
 */
export function resolveStack(projectDir: string, outDir: string): ResolvedStack | null {
  const projectName = projectNameFor(projectDir);
  const materialised = join(projectDir, outDir, "stack");

  if (existsSync(join(materialised, "docker-compose.yml"))) {
    return { stackDir: relative(projectDir, materialised) || ".", projectName };
  }

  const source = locateStack(PACKAGE_DIR, projectDir);
  if (!source) return null;
  return { stackDir: relative(projectDir, source.root) || ".", projectName };
}
