import { Decision } from "@shared/enums/decision.enum";
import { DecisionSource } from "@shared/enums/decision-source.enum";
import { RuleAction } from "@shared/enums/rule-action.enum";
import { RuleStage } from "@shared/enums/rule-stage.enum";
import { RuleExpression } from "@shared/rules/rule.types";
import { ReasonCode } from "@shared/onnx/reason-codes";
import { PredictRequestDto, PredictResponseDto } from "../dtos/predict-request.dto";

export interface PredictInvocation {
  request: PredictRequestDto;
  traceId: string;
  tenantId?: string | null;
  apiKeyId?: string | null;
  idempotencyKey?: string | null;
}

export type PredictOutcome =
  | { kind: "ok"; response: PredictResponseDto; latencyMs: number }
  | { kind: "replay"; response: Record<string, unknown> }
  | { kind: "conflict" }
  | { kind: "in_flight" }
  | { kind: "duplicate"; transactionId: string };

export interface PredictRuleHit {
  rule: { id: string; name: string; action: RuleAction; expression: RuleExpression };
  stage: RuleStage;
}

export type MlDecision = Decision.ACCEPT | Decision.DECLINE | Decision.REVIEW;

export interface ModelMeta {
  championVersion: string;
  shadowVersion: string | null;
  threshold: number;
  reviewThreshold: number | null;
}

export interface FeaturesPayload {
  enrichedVector: Float32Array;
  snapshot: Record<string, number>;
  isDefault: boolean;
}

export interface MlOutcome {
  score: number;
  calibratedScore: number | null;
  decision: MlDecision;
  degraded: boolean;
}

export type MlDecisionSource =
  | DecisionSource.ML
  | DecisionSource.POST_RULE
  | DecisionSource.BREAKER_FALLBACK;

export interface FinalVerdict {
  postRule: PredictRuleHit | null;
  finalDecision: Decision;
  decisionSource: MlDecisionSource;
}

export interface PreRuleContextInput {
  invocation: PredictInvocation;
  request: PredictRequestDto;
  startTime: number;
  rule: PredictRuleHit;
  finalDecision: Decision;
  threshold: number;
  championVersion: string;
  shadowVersion: string | null;
  reasonCodes: ReasonCode[] | null;
  featuresSnapshot: Record<string, number> | null;
  isDefault: boolean;
}

export interface MlDecisionContextInput {
  invocation: PredictInvocation;
  request: PredictRequestDto;
  startTime: number;
  postRule: PredictRuleHit | null;
  finalDecision: Decision;
  decisionSource: MlDecisionSource;
  mlScore: number;
  calibratedScore: number | null;
  mlDecision: MlDecision;
  threshold: number;
  championVersion: string;
  shadowVersion: string | null;
  shadowScore: number | null;
  reasonCodes: ReasonCode[] | null;
  featuresSnapshot: Record<string, number> | null;
  isDefault: boolean;
}

export interface PredictDecisionContext {
  invocation: PredictInvocation;
  request: PredictRequestDto;
  startTime: number;
  finalDecision: Decision;
  decisionSource: DecisionSource;
  rule: PredictRuleHit | null;
  mlScore: number;
  calibratedScore: number | null;
  mlDecision: MlDecision;
  threshold: number;
  championVersion: string;
  shadowVersion: string | null;
  shadowScore: number | null;
  reasonCodes: ReasonCode[] | null;
  featuresSnapshot: Record<string, number> | null;
  isDefault: boolean;
}
