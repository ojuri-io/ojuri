import { RuleAction, RuleExpression, RuleStage } from "../../shared/rules/rule.types";

export interface BehavioralRule {
  name: string;
  description: string;
  stage: RuleStage;
  priority: number;
  action: RuleAction;
  expression: RuleExpression;
}
