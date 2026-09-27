import { Decision } from "../enums/decision.enum.js";
import { DecisionSource } from "../enums/decision-source.enum.js";
import { RuleStage } from "../enums/rule-stage.enum.js";
import { WebhookEvent } from "../enums/webhook-event.enum.js";
import { ReasonCode } from "../types/predict.types.js";

export interface DecisionCreatedPayload {
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  decision: `${Decision}`;
  decision_source: `${DecisionSource}`;
  model_version: string;
  fraud_probability: number;
  reason_codes: ReasonCode[];
  audit_id: string | null;
}

export interface DecisionOverriddenPayload {
  audit_id: string;
  transaction_id: string;
  original_decision: `${Decision}`;
  override_decision: `${Decision.ACCEPT}` | `${Decision.DECLINE}`;
  reviewer: string;
  reason?: string;
}

export interface ModelActivatedPayload {
  version: string;
  source_uri: string | null;
  sha256: string | null;
  default_threshold: number;
  activated_at: string;
}

export interface RuleActivatedPayload {
  rule_id: string;
  name: string;
  stage: `${RuleStage}`;
  action: string;
  priority: number;
  activated_at: string;
}

export interface WebhookPayloads {
  [WebhookEvent.DECISION_CREATED]: DecisionCreatedPayload;
  [WebhookEvent.DECISION_OVERRIDDEN]: DecisionOverriddenPayload;
  [WebhookEvent.MODEL_ACTIVATED]: ModelActivatedPayload;
  [WebhookEvent.RULE_ACTIVATED]: RuleActivatedPayload;
}

export type WebhookEnvelope = {
  [E in keyof WebhookPayloads]: { event: E; data: WebhookPayloads[E]; sent_at: string };
}[keyof WebhookPayloads];
