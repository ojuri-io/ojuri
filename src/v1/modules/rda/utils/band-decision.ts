import { Decision } from "@shared/enums/decision.enum";
import { MlDecision } from "../services/predict.types";

export function bandDecision(
  score: number,
  threshold: number,
  reviewThreshold: number | null,
): MlDecision {
  if (score >= threshold) return Decision.DECLINE;
  if (reviewThreshold !== null && score >= reviewThreshold) return Decision.REVIEW;
  return Decision.ACCEPT;
}
