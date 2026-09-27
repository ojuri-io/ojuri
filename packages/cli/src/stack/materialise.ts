import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUNDLED_FILES, RUNTIME_DIRECTORIES } from "./assets";
import type { MaterialiseResult, StackSource } from "./stack.types";

/**
 * Unpacks the bundled stack beside the adopter's manifest so Compose has real
 * files to bind-mount. Existing files are left alone: an operator who edited
 * the materialised nginx.conf keeps that edit across upgrades.
 */
export function materialiseStack(source: StackSource, targetDir: string): MaterialiseResult {
  if (!source.bundled) {
    return { stackDir: source.root, copied: [], kept: [] };
  }

  const copied: string[] = [];
  const kept: string[] = [];

  for (const relative of BUNDLED_FILES) {
    const from = join(source.root, relative);
    if (!existsSync(from)) continue;

    const to = join(targetDir, relative);
    if (existsSync(to)) {
      kept.push(relative);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(relative);
  }

  for (const relative of RUNTIME_DIRECTORIES) {
    mkdirSync(join(targetDir, relative), { recursive: true });
  }

  return { stackDir: targetDir, copied, kept };
}
