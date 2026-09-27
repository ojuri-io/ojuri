import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUNDLED_FILES } from "../dist/stack/assets.js";

// Runs on prepack, so the tarball carries the stack while the repository keeps
// exactly one copy of every file. Nothing to drift, nothing to byte-check.
const packageDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageDir, "..", "..");
const target = join(packageDir, "stack");

rmSync(target, { recursive: true, force: true });

const missing = [];
for (const relative of BUNDLED_FILES) {
  const from = join(repoRoot, relative);
  if (!existsSync(from)) {
    missing.push(relative);
    continue;
  }
  const to = join(target, relative);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

if (missing.length > 0) {
  console.error(`sync-stack: missing from ${repoRoot}:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

console.log(`sync-stack: ${BUNDLED_FILES.length} files into ${target}`);
