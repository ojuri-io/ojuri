/**
 * Reason-code explainer.
 *
 * Computes a lightweight, deterministic top-N feature-contribution
 * vector that can be returned on every `/v1/predict` response.
 *
 * Approach: each named feature has an expected baseline value and
 * a sign-aware weight (positive = increases risk, negative =
 * decreases risk). Contribution is `weight * tanh(z)` where `z` is
 * the normalised deviation from baseline. This is intentionally
 * cheaper than full SHAP — every microsecond on the predict path
 * counts. For deep narrative reasoning, the FIA service is the
 * right place (see `/v1/reports`).
 *
 * Specs reference catalogue features by NAME; vector positions are
 * resolved from the loaded feature catalogue, so a catalogue reorder
 * can never silently misattribute a reason code. Only the subset of
 * features below is surfaced; the rest still feed the model but are
 * explained via the FIA narrative (`POST /v1/reports`).
 */

import { loadCatalog } from "@shared/features/feature-catalog";
import { ReasonBasis, ReasonCode, ReasonFeatureSpec } from "./reason-codes.types";

export type { ReasonCode, ReasonFeatureSpec } from "./reason-codes.types";
export { ReasonBasis } from "./reason-codes.types";

const SPECS: ReasonFeatureSpec[] = [
  { feature: "velocity_1h",                code: "VELOCITY_1H",      description: "Transactions in the last hour above baseline", baseline: 1,     scale: 5,     weight:  0.30 },
  { feature: "velocity_24h",               code: "VELOCITY_24H",     description: "Transactions in the last 24 hours above baseline", baseline: 5,     scale: 25,    weight:  0.25 },
  { feature: "velocity_7d",                code: "VELOCITY_7D",      description: "Transactions in the last 7 days above baseline", baseline: 20,    scale: 80,    weight:  0.10 },
  { feature: "amount_mean_30d",            code: "AVG_AMOUNT_30D",   description: "Sender's 30-day average transaction amount", baseline: 100,   scale: 1000,  weight: -0.05 },
  { feature: "amount_std_30d",             code: "STD_AMOUNT_30D",   description: "Variance of sender's recent transaction amounts", baseline: 50,    scale: 500,   weight:  0.10 },
  { feature: "graph_pagerank",             code: "PAGERANK",         description: "Network-centrality score from the transaction graph", baseline: 0.001, scale: 0.005, weight: -0.20 },
  { feature: "graph_clustering_coef",      code: "CLUSTERING_COEF",  description: "How tightly the sender clusters with known peers", baseline: 0.4,   scale: 0.4,   weight: -0.15 },
  { feature: "pair_time_since_last_send",  code: "TIME_SINCE_LAST",  description: "Seconds since the sender last sent to this receiver", baseline: 3600,  scale: 7200,  weight:  0.10 },
  { feature: "is_weekend",                 code: "WEEKEND",          description: "Transaction occurred on a weekend", baseline: 0,     scale: 1,     weight:  0.05 },
  { feature: "hour_of_day",                code: "HOUR_OF_DAY",      description: "Hour of day deviates from sender's norm", baseline: 12,    scale: 12,    weight:  0.05 },
  { feature: "amount",                     code: "AMOUNT_HIGH",      description: "Transaction amount relative to typical range", baseline: 100,   scale: 10000, weight:  0.35 },
  { feature: "transaction_type_code",      code: "TRANSACTION_TYPE", description: "Transaction type associated with elevated risk", baseline: 0,     scale: 4,     weight:  0.05 },
];

/**
 * Public catalogue of reason codes. Exposed to admin UIs (Audit log
 * filter chips) so they don't ship hardcoded lists. Each entry is
 * `{ code, description }`; weights/baselines are deliberately private
 * (callers don't need them and they may shift between model versions).
 */
export const REASON_CODE_CATALOGUE: Array<{ code: string; description: string }> = SPECS.map(
  (s) => ({ code: s.code, description: s.description })
);

type ResolvedSpec = ReasonFeatureSpec & { index: number };

let resolvedSpecs: ResolvedSpec[] | null = null;
let modelWeights: Record<string, number> | null = null;

function resolveSpecs(): ResolvedSpec[] {
  if (resolvedSpecs) return resolvedSpecs;
  const { byName } = loadCatalog();
  resolvedSpecs = SPECS.map((spec) => {
    const feature = byName.get(spec.feature);
    if (!feature) {
      throw new Error(
        `reason-code spec references unknown catalogue feature '${spec.feature}'`
      );
    }
    return { ...spec, index: feature.index };
  });
  return resolvedSpecs;
}

/**
 * Replace the hand-set weight magnitudes with the deployed model's
 * normalised gain importances, keeping each spec's sign — direction is
 * domain knowledge the importances don't carry. Called on every model
 * load; passing null reverts to the built-in constants.
 */
export function setModelWeights(weights: Record<string, number> | null): void {
  if (!weights) {
    modelWeights = null;
    return;
  }
  const usable = Object.entries(weights).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0
  );
  const max = usable.reduce((m, [, v]) => Math.max(m, v), 0);
  if (usable.length === 0 || max <= 0) {
    modelWeights = null;
    return;
  }
  modelWeights = Object.fromEntries(usable.map(([k, v]) => [k, v / max]));
}

function weightFor(spec: ReasonFeatureSpec): { weight: number; basis: ReasonBasis } {
  const learned = modelWeights?.[spec.feature];
  if (learned === undefined) {
    return { weight: spec.weight, basis: ReasonBasis.HEURISTIC };
  }
  return {
    weight: Math.sign(spec.weight) * learned,
    basis: ReasonBasis.MODEL_WEIGHTED,
  };
}

/** Test-only — clears memoised catalogue positions and model weights. */
export function _resetResolvedSpecsForTests(): void {
  resolvedSpecs = null;
  modelWeights = null;
}

export function explain(features: Float32Array, topN = 3): ReasonCode[] {
  const contributions: ReasonCode[] = [];

  for (const spec of resolveSpecs()) {
    const value = features[spec.index];
    if (value === undefined || Number.isNaN(value)) continue;

    const z = (value - spec.baseline) / (spec.scale || 1);
    const { weight, basis } = weightFor(spec);
    const contribution = weight * Math.tanh(z);

    contributions.push({
      code: spec.code,
      description: spec.description,
      contribution: round(contribution),
      value: round(value),
      basis,
    });
  }

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return contributions.slice(0, topN);
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
