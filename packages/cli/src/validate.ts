import { countBySeverity, type Finding } from "./findings";
import { loadManifest } from "./manifest/load";
import { applyRules } from "./manifest/rules";
import { validateAgainstSchema } from "./manifest/schema";

export interface ValidationResult {
  path: string;
  findings: Finding[];
  ok: boolean;
}

/**
 * Schema first, then the semantic rules. A document that fails the
 * schema is not passed to the rules: they read fields the schema has
 * just said cannot be trusted, and the second round of errors would
 * bury the first.
 */
export function validateManifest(
  path: string,
  processEnv: Record<string, string | undefined> = process.env
): ValidationResult {
  const loaded = loadManifest(path, processEnv);

  if (loaded.manifest === null) {
    return { path: loaded.path, findings: loaded.findings, ok: false };
  }

  const schemaFindings = validateAgainstSchema(loaded.manifest);
  if (schemaFindings.length > 0) {
    return { path: loaded.path, findings: schemaFindings, ok: false };
  }

  const findings = applyRules(loaded.manifest, loaded.env);
  return { path: loaded.path, findings, ok: countBySeverity(findings).errors === 0 };
}
