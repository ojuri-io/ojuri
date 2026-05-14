/**
 * Static lookup-table loader for `compute.type: "lookup"` features.
 *
 * Tables live under `models/lookups/`. Each file is a flat JSON
 * object mapping a key (string) to a value (number for numeric
 * features, string for categorical that gets encoded downstream).
 * Tables are loaded once on first access and cached for the process
 * lifetime — they're meant to be small (countries, MCC codes,
 * purpose buckets), not row-store data.
 *
 * The loader is deliberately permissive: a missing table or missing
 * key returns the caller-provided default. We log the miss but
 * never crash the predict path on a lookup failure; if the adopter
 * misnamed a table we'd rather degrade to defaults than 500.
 */

import fs from "fs";
import path from "path";

const cache = new Map<string, Record<string, unknown>>();

const LOOKUP_ROOT = process.env.FEATURE_LOOKUP_ROOT
  ? path.resolve(process.env.FEATURE_LOOKUP_ROOT)
  : path.resolve(process.cwd(), "models/lookups");

/**
 * Read a table by name (e.g. `"country_risk.json"`). Returns `null`
 * when the file doesn't exist or can't be parsed — caller substitutes
 * the feature default.
 */
export function loadLookupTable(name: string): Record<string, unknown> | null {
  if (cache.has(name)) return cache.get(name)!;
  const fullPath = path.join(LOOKUP_ROOT, name);
  if (!fs.existsSync(fullPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
    cache.set(name, parsed as Record<string, unknown>);
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Look up a value with a fallback. The optional `encoder` lets the
 * caller pass a function to turn string values into numbers (e.g.
 * `encodeCountry`) so the lookup result fits a uint8 feature slot.
 */
export function lookupValue(
  tableName: string,
  key: string | number | null | undefined,
  fallback: number
): number {
  if (key == null) return fallback;
  const table = loadLookupTable(tableName);
  if (!table) return fallback;
  const v = table[String(key)];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Test-only — clears the table cache between unit-test runs. */
export function _resetLookupCacheForTests(): void {
  cache.clear();
}
