/**
 * Regression test for the singleton-via-alias bug from §6b and §6l.
 *
 * In dev mode the `@shared/*` alias resolves through module-alias to
 * `dist/`, while a relative `./shared/...` import resolves through
 * ts-node to `src/`. The two paths produce distinct module-cache
 * entries → distinct class objects → distinct tsyringe singleton
 * registrations. `server.ts`-side initialisation never reaches the
 * predict-side singleton, and everything looks fine until the system
 * silently serves uninitialised state.
 *
 * Jest's moduleNameMapper collapses both forms onto src/, so a runtime
 * test of "two resolves return the same instance" always passes —
 * it can't reproduce the bug. The real invariant is at the import
 * level: every @singleton class imported by `src/server.ts` must come
 * through `@shared/...`. This test enforces that by scanning the
 * source.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const PROJECT_ROOT = resolve(__dirname, "..", "..");
const SERVER_TS = resolve(PROJECT_ROOT, "src", "server.ts");

function collectSingletonClassNames(): Set<string> {
  // Walk every file under src/shared/ and pick up classes decorated
  // with `@singleton()`. The decorator is always on the line directly
  // above `class <Name>`, so a line-level scan is sufficient.
  const { readdirSync, statSync } = require("fs") as typeof import("fs");
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts") || entry.endsWith(".test.ts")) continue;
      const src = readFileSync(full, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (line.trim() === "@singleton()") {
          // Find the class declaration after the decorator (skip
          // intervening blank lines).
          for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
            const m = /^(?:export\s+default\s+)?class\s+(\w+)/.exec(lines[j]!);
            if (m) {
              names.add(m[1]!);
              break;
            }
          }
        }
      });
    }
  };
  walk(resolve(PROJECT_ROOT, "src", "shared"));
  return names;
}

describe("server.ts singleton import paths", () => {
  it("imports every @singleton class via the @shared/ alias, not a relative path", () => {
    const serverSrc = readFileSync(SERVER_TS, "utf8");
    const singletons = collectSingletonClassNames();
    expect(singletons.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of singletons) {
      // Skip classes server.ts doesn't import at all.
      if (!new RegExp(`import\\s+(?:default\\s+as\\s+)?\\b${name}\\b`).test(serverSrc)) continue;

      const aliasedImport = new RegExp(
        `import\\s+${name}\\s+from\\s+["']@shared/`
      ).test(serverSrc);
      const relativeImport = new RegExp(
        `import\\s+${name}\\s+from\\s+["']\\./shared/`
      ).test(serverSrc);

      if (relativeImport || !aliasedImport) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });
});
