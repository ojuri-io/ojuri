export type RuleStage = "PRE" | "POST";
export type RuleAction = "ALLOW" | "DENY" | "REVIEW" | "NONE";

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

  // Available only on POST-stage evaluation
  ml_score?: number;
  ml_decision?: "ACCEPT" | "DECLINE";

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
