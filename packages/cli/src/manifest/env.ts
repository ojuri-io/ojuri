import { readFileSync, existsSync } from "node:fs";

/**
 * Environment the manifest resolves against. The process environment
 * wins over `.env`, matching how Compose itself resolves substitutions,
 * so exporting a variable in a shell overrides the file for both.
 */
export interface EnvSource {
  /** Values parsed from the `.env` file sitting next to the manifest. */
  dotenv: Record<string, string>;
  /** The process environment, or a stand-in in tests. */
  process: Record<string, string | undefined>;
}

export function lookup(env: EnvSource, name: string): string | undefined {
  const fromProcess = env.process[name];
  if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
  return env.dotenv[name];
}

/**
 * Minimal `.env` parser. Deliberately not dotenv: this reads a file the
 * CLI does not own, and the only shapes that matter are the ones
 * `.env.example` uses. Handles `KEY=value`, `export KEY=value`, single
 * and double quotes, `#` comments, and blank lines. Does not expand
 * variables inside values, because Compose does not either.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing unquoted comment, e.g. `PORT=80 # the default`.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export function loadDotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseDotenv(readFileSync(path, "utf8"));
}

export interface UnresolvedRef {
  /** Dotted path into the manifest where the reference appeared. */
  path: string;
  /** The variable name that could not be resolved. */
  name: string;
}

export interface ResolveResult<T> {
  value: T;
  unresolved: UnresolvedRef[];
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Walk the parsed manifest substituting `${VAR}` in every string.
 * Unresolved references are left in place as their literal text, so the
 * document still type-checks against the schema, and reported back so
 * the rules can decide whether the field they sit in was required.
 */
export function resolveReferences<T>(input: T, env: EnvSource): ResolveResult<T> {
  const unresolved: UnresolvedRef[] = [];

  function walk(node: unknown, path: string): unknown {
    if (typeof node === "string") {
      return node.replace(REFERENCE, (whole, name: string) => {
        const found = lookup(env, name);
        if (found === undefined) {
          unresolved.push({ path, name });
          return whole;
        }
        return found;
      });
    }
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${path}[${i}]`));
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(value, path === "" ? key : `${path}.${key}`);
      }
      return out;
    }
    return node;
  }

  return { value: walk(input, "") as T, unresolved };
}

/** True when the string still carries an unsubstituted `${VAR}`. */
export function hasUnresolvedReference(value: string | undefined): boolean {
  if (value === undefined) return false;
  REFERENCE.lastIndex = 0;
  return REFERENCE.test(value);
}
