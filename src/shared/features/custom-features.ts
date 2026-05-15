/**
 * Adopter extension point for code-based feature resolvers.
 *
 * The declarative compute algebra (`from_field`, `equals`, `ratio`,
 * `lookup`, `bool_and`, `from_redis`, …) covers the 90% case. When a
 * feature needs control flow the algebra can't express — a multi-field
 * heuristic, a call into another service, a derivation that mixes
 * Redis + request + a lookup — adopters wire a `{ type: "custom",
 * resolver: "<name>" }` compute op in their overlay file and register
 * the resolver here at boot time.
 *
 * The resolver receives the full `ComputeContext` plus the catalogue
 * spec and returns a single number. It must be:
 *
 *   • **Pure** — same inputs, same output. The Python mirror has to
 *     produce the same value at training time; non-determinism is a
 *     silent train/serve skew that the schema-version mechanism
 *     can't catch (the catalogue file is identical).
 *   • **Fast** — runs synchronously on every predict. Anything that
 *     would need an await belongs in PAA, not here.
 *   • **Defensive** — request fields can be missing or the wrong
 *     type. Return the catalogue default rather than throwing.
 *
 * Registration is at module load. Adopters typically create
 * `src/custom-features/index.ts` and import it from `src/bootstrap.ts`
 * before the Fastify server starts so the resolvers are in place when
 * the first request lands.
 */

import { ComputeContext } from "./compute-op-executor";
import { FeatureSpec } from "./feature-catalog.types";

export type CustomFeatureResolver = (ctx: ComputeContext, spec: FeatureSpec) => number;

const registry = new Map<string, CustomFeatureResolver>();

/**
 * Register a code-based resolver. Idempotent — registering the same
 * name twice overwrites silently so adopters can hot-reload during
 * development. The name MUST match the `resolver` field on a
 * `{ type: "custom" }` compute op in the catalogue overlay.
 */
export function registerCustomFeature(name: string, fn: CustomFeatureResolver): void {
  registry.set(name, fn);
}

export function getCustomFeature(name: string): CustomFeatureResolver | undefined {
  return registry.get(name);
}

/** Test-only — clears the registry. */
export function _resetCustomFeaturesForTests(): void {
  registry.clear();
}

/** Names currently registered. Used by an admin endpoint for visibility. */
export function listCustomFeatures(): string[] {
  return Array.from(registry.keys()).sort();
}
