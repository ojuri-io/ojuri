import { RuleAction, RuleExpression, RuleStage } from "@shared/rules/rule.types";

export interface CreateRuleDto {
  name: string;
  action: RuleAction;
  expression: RuleExpression;
  description?: string;
  stage?: RuleStage;
  priority?: number;
  tenantId?: string;
}

export interface UpdateRuleDto {
  name?: string;
  description?: string;
  stage?: RuleStage;
  priority?: number;
  action?: RuleAction;
  expression?: RuleExpression;
  isActive?: boolean;
}
