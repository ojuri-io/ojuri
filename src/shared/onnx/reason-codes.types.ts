/**
 * `basis` tells an investigator how much weight the number deserves.
 * MODEL_WEIGHTED magnitudes come from the deployed model's gain
 * importances; HEURISTIC ones are hand-set constants that can contradict
 * what the model actually learned. Neither is per-transaction attribution
 * — that is FIA's job (`POST /v1/reports`).
 */
export enum ReasonBasis {
  MODEL_WEIGHTED = "MODEL_WEIGHTED",
  HEURISTIC = "HEURISTIC",
}

export interface ReasonCode {
  code: string;
  description: string;
  contribution: number;
  value: number;
  basis: ReasonBasis;
}

export interface ReasonFeatureSpec {
  feature: string;
  code: string;
  description: string;
  baseline: number;
  scale: number;
  weight: number;
}
