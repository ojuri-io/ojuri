import { RuleAction, RuleExpression, RuleStage } from "@shared/rules/rule.types";

export interface FatfRule {
  name: string;
  description: string;
  stage: RuleStage;
  priority: number;
  action: RuleAction;
  expression: RuleExpression;
}
