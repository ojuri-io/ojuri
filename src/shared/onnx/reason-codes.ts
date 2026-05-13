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
 * The catalogue covers feature positions 0..11 (everything Redis +
 * the on-the-fly enrichment in PredictService sets). The remaining
 * 422 padding dimensions are ignored by design — they're the
 * "PROTOTYPE MODE" placeholders documented in CLAUDE.md.
 */

export interface ReasonCode {
  code: string;
  description: string;
  contribution: number;
  value: number;
}

interface FeatureSpec {
  index: number;
  code: string;
  description: string;
  baseline: number;
  scale: number;
  weight: number;
}

const FEATURES: FeatureSpec[] = [
  { index: 0,  code: "VELOCITY_1H",        description: "Transactions in the last hour above baseline", baseline: 1,   scale: 5,    weight:  0.30 },
  { index: 1,  code: "VELOCITY_24H",       description: "Transactions in the last 24 hours above baseline", baseline: 5,   scale: 25,   weight:  0.25 },
  { index: 2,  code: "VELOCITY_7D",        description: "Transactions in the last 7 days above baseline", baseline: 20,  scale: 80,   weight:  0.10 },
  { index: 3,  code: "AVG_AMOUNT_30D",     description: "Sender's 30-day average transaction amount", baseline: 100, scale: 1000, weight: -0.05 },
  { index: 4,  code: "STD_AMOUNT_30D",     description: "Variance of sender's recent transaction amounts", baseline: 50,  scale: 500,  weight:  0.10 },
  { index: 5,  code: "PAGERANK",           description: "Network-centrality score from the transaction graph", baseline: 0.5, scale: 0.4,  weight: -0.20 },
  { index: 6,  code: "CLUSTERING_COEF",    description: "How tightly the sender clusters with known peers", baseline: 0.4, scale: 0.4,  weight: -0.15 },
  { index: 7,  code: "TIME_SINCE_LAST",    description: "Seconds since the sender's previous transaction", baseline: 3600, scale: 7200, weight:  0.10 },
  { index: 8,  code: "WEEKEND",            description: "Transaction occurred on a weekend", baseline: 0,   scale: 1,    weight:  0.05 },
  { index: 9,  code: "HOUR_OF_DAY",        description: "Hour of day deviates from sender's norm", baseline: 12,  scale: 12,   weight:  0.05 },
  { index: 10, code: "AMOUNT_HIGH",        description: "Transaction amount relative to typical range", baseline: 100, scale: 10000, weight: 0.35 },
  { index: 11, code: "TRANSACTION_TYPE",   description: "Transaction type associated with elevated risk", baseline: 0,   scale: 4,    weight:  0.05 },
];

export function explain(features: Float32Array, topN = 3): ReasonCode[] {
  const contributions: ReasonCode[] = [];

  for (const spec of FEATURES) {
    const value = features[spec.index];
    if (value === undefined || Number.isNaN(value)) continue;

    const z = (value - spec.baseline) / (spec.scale || 1);
    const contribution = spec.weight * Math.tanh(z);

    contributions.push({
      code: spec.code,
      description: spec.description,
      contribution: round(contribution),
      value: round(value),
    });
  }

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return contributions.slice(0, topN);
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
