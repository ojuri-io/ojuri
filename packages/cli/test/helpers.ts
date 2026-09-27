import { join } from "node:path";
import type { Finding } from "../src/findings";
import { validateManifest } from "../src/validate";

export const FIXTURES = join(__dirname, "fixtures");

export function fixture(name: string): string {
  return join(FIXTURES, name);
}

/**
 * A deliberately empty environment. Specs opt into the variables they
 * care about, so an inherited NODE_ENV or AUTH_JWT_SECRET on the
 * developer's shell cannot change a result.
 */
export const EMPTY_ENV: Record<string, string | undefined> = {};

export function validateFixture(
  name: string,
  env: Record<string, string | undefined> = EMPTY_ENV
): { findings: Finding[]; ok: boolean } {
  const result = validateManifest(fixture(name), env);
  return { findings: result.findings, ok: result.ok };
}

export function codes(findings: Finding[]): string[] {
  return findings.map((f) => f.code);
}

export function errorCodes(findings: Finding[]): string[] {
  return findings.filter((f) => f.severity === "error").map((f) => f.code);
}

export function warningCodes(findings: Finding[]): string[] {
  return findings.filter((f) => f.severity === "warning").map((f) => f.code);
}

export function findByCode(findings: Finding[], code: string): Finding | undefined {
  return findings.find((f) => f.code === code);
}
