import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StackSource } from "./stack.types";

const COMPOSE = "docker-compose.yml";
const BUNDLE_DIR = "stack";

/**
 * A published package carries the stack under `stack/`; a checkout has it at
 * the repository root. Preferring the bundle keeps `npx` runs reproducible,
 * and the walk keeps a developer's `node dist/index.js` working unchanged.
 */
export function locateStack(packageDir: string, startDir: string): StackSource | null {
  const bundled = join(packageDir, BUNDLE_DIR);
  if (existsSync(join(bundled, COMPOSE))) return { root: bundled, bundled: true };

  for (const from of [startDir, packageDir]) {
    const found = walkUp(resolve(from));
    if (found) return { root: found, bundled: false };
  }
  return null;
}

function walkUp(from: string): string | null {
  let current = from;
  for (;;) {
    if (existsSync(join(current, COMPOSE))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
