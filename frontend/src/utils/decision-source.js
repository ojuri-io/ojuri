export const RULE_SOURCES = ['PRE_RULE', 'POST_RULE'];

export function isRuleSource(source, stage) {
  return RULE_SOURCES.includes(source) || stage === 'PRE_RULE';
}

/**
 * BREAKER_FALLBACK means inference never ran, so labelling it "ML"
 * presents a fail-safe constant as a model verdict.
 */
export function decisionSourceLabel(source, stage) {
  if (source === 'REVIEWER_OVERRIDE') return 'OVERRIDE';
  if (source === 'BREAKER_FALLBACK') return 'DEGRADED';
  if (isRuleSource(source, stage)) return 'RULE';
  return 'ML';
}
