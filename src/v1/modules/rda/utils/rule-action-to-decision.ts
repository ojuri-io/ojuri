import { Decision } from "@shared/enums/decision.enum";
import { RuleAction } from "@shared/enums/rule-action.enum";

const MAPPING: Record<Exclude<RuleAction, RuleAction.NONE>, Decision> = {
  [RuleAction.ALLOW]: Decision.ACCEPT,
  [RuleAction.DENY]: Decision.DECLINE,
  [RuleAction.REVIEW]: Decision.REVIEW,
};

export function ruleActionToDecision(action: Exclude<RuleAction, RuleAction.NONE>): Decision {
  return MAPPING[action];
}
