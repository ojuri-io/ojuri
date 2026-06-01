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

export interface ModelMeta {
  championVersion: string;
  shadowVersion: string | null;
  threshold: number;
}

export interface FeaturesPayload {
  enrichedVector: Float32Array;
  snapshot: Record<string, number>;
  isDefault: boolean;
}

export interface MlOutcome {
  score: number;
  decision: Decision.ACCEPT | Decision.DECLINE;
}

export interface FinalVerdict {
  postRule: PredictRuleHit | null;
  finalDecision: Decision;
  decisionSource: DecisionSource.ML | DecisionSource.POST_RULE;
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
  reasonCodes: ReasonCode[];
  featuresSnapshot: Record<string, number>;
  isDefault: boolean;
}

export interface MlDecisionContextInput {
  invocation: PredictInvocation;
  request: PredictRequestDto;
  startTime: number;
  postRule: PredictRuleHit | null;
  finalDecision: Decision;
  decisionSource: DecisionSource.ML | DecisionSource.POST_RULE;
  mlScore: number;
  mlDecision: Decision.ACCEPT | Decision.DECLINE;
  threshold: number;
  championVersion: string;
  shadowVersion: string | null;
  reasonCodes: ReasonCode[];
  featuresSnapshot: Record<string, number>;
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
  mlDecision: Decision.ACCEPT | Decision.DECLINE;
  threshold: number;
  championVersion: string;
  shadowVersion: string | null;
  reasonCodes: ReasonCode[];
  featuresSnapshot: Record<string, number>;
  isDefault: boolean;
}
