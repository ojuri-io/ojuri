import { Decision } from "@shared/enums/decision.enum";
import { DecisionSource } from "@shared/enums/decision-source.enum";
import {
  MlDecisionContextInput,
  PredictDecisionContext,
  PreRuleContextInput,
} from "../services/predict.types";

class PredictDecisionContextFactory {
  static fromPreRule(input: PreRuleContextInput): PredictDecisionContext {
    return {
      invocation: input.invocation,
      request: input.request,
      startTime: input.startTime,
      finalDecision: input.finalDecision,
      decisionSource: DecisionSource.PRE_RULE,
      rule: input.rule,
      mlScore: 0,
      calibratedScore: null,
      mlDecision: Decision.ACCEPT,
      threshold: input.threshold,
      championVersion: input.championVersion,
      shadowVersion: input.shadowVersion,
      shadowScore: null,
      reasonCodes: input.reasonCodes,
      featuresSnapshot: input.featuresSnapshot,
      isDefault: input.isDefault,
    };
  }

  static fromMlDecision(input: MlDecisionContextInput): PredictDecisionContext {
    return {
      invocation: input.invocation,
      request: input.request,
      startTime: input.startTime,
      finalDecision: input.finalDecision,
      decisionSource: input.decisionSource,
      rule: input.postRule,
      mlScore: input.mlScore,
      calibratedScore: input.calibratedScore,
      mlDecision: input.mlDecision,
      threshold: input.threshold,
      championVersion: input.championVersion,
      shadowVersion: input.shadowVersion,
      shadowScore: input.shadowScore,
      reasonCodes: input.reasonCodes,
      featuresSnapshot: input.featuresSnapshot,
      isDefault: input.isDefault,
    };
  }
}

export default PredictDecisionContextFactory;
