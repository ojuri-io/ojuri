import { Decision } from "@shared/enums/decision.enum";
import { RuleAction } from "@shared/enums/rule-action.enum";
import { RuleStage } from "@shared/enums/rule-stage.enum";

export { RuleAction, RuleStage };

export interface RuleRecord {
  id: string;
  name: string;
  description: string | null;
  stage: RuleStage;
  priority: number;
  action: RuleAction;
  expression: RuleExpression;
  isActive: boolean;
  tenantId: string | null;
}

export type RuleExpression =
  | { "var": string }
  | { "==": [RuleExpression, RuleExpression] }
  | { "!=": [RuleExpression, RuleExpression] }
  | { ">": [RuleExpression, RuleExpression] }
  | { ">=": [RuleExpression, RuleExpression] }
  | { "<": [RuleExpression, RuleExpression] }
  | { "<=": [RuleExpression, RuleExpression] }
  | { "and": RuleExpression[] }
  | { "or": RuleExpression[] }
  | { "not": RuleExpression }
  | { "in": [RuleExpression, RuleExpression] }
  | string
  | number
  | boolean
  | null
  | (string | number | boolean | null)[];

export interface RuleContext {
  // Request payload
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  transaction_type: string;
  timestamp: number;
  segment?: string;
  tenant_id?: string;

  // Geography + auth + device signals propagated from PredictRequestDto.
  // Rules engine has line-of-sight to all of these without going through
  // Redis/PAA.
  ip_country?: string;
  transaction_country?: string;
  destination_country?: string;
  ip_is_vpn?: boolean;
  device_is_trusted?: boolean;
  is_authenticated?: boolean;
  session_to_txn_seconds?: number;
  account_age_days?: number;
  channel?: string;
  currency?: string;

  // Available only on POST-stage evaluation
  ml_score?: number;
  ml_decision?: Decision.ACCEPT | Decision.DECLINE | Decision.REVIEW;

  // Numeric features made available by name for convenience
  features?: Record<string, number>;
}

export interface RuleHit {
  rule: RuleRecord;
  stage: RuleStage;
}

export interface CreateRuleInput {
  name: string;
  action: RuleAction;
  expression: RuleExpression;
  description?: string;
  stage?: RuleStage;
  priority?: number;
  tenantId?: string;
  isActive?: boolean;
  createdBy?: string | null;
}

export interface UpdateRuleInput {
  name?: string;
  description?: string;
  stage?: RuleStage;
  priority?: number;
  action?: RuleAction;
  expression?: RuleExpression;
  isActive?: boolean;
}
