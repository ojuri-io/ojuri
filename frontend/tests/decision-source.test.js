import { describe, it, expect } from 'vitest';
import { decisionSourceLabel, isRuleSource } from '../src/utils/decision-source.js';

describe('decisionSourceLabel', () => {
  it('labels rule-driven decisions', () => {
    expect(decisionSourceLabel('PRE_RULE')).toBe('RULE');
    expect(decisionSourceLabel('POST_RULE')).toBe('RULE');
    expect(decisionSourceLabel(null, 'PRE_RULE')).toBe('RULE');
  });

  it('labels reviewer overrides', () => {
    expect(decisionSourceLabel('REVIEWER_OVERRIDE')).toBe('OVERRIDE');
  });

  // The model never scored these — showing "ML" presents the breaker's
  // fail-safe constant as a model verdict.
  it('distinguishes a breaker fallback from a real model decision', () => {
    expect(decisionSourceLabel('BREAKER_FALLBACK')).toBe('DEGRADED');
    expect(decisionSourceLabel('ML')).toBe('ML');
  });

  it('falls back to ML for unknown or missing sources', () => {
    expect(decisionSourceLabel(undefined)).toBe('ML');
  });
});

describe('isRuleSource', () => {
  it('is true only for rule stages', () => {
    expect(isRuleSource('PRE_RULE')).toBe(true);
    expect(isRuleSource('POST_RULE')).toBe(true);
    expect(isRuleSource('BREAKER_FALLBACK')).toBe(false);
    expect(isRuleSource('ML')).toBe(false);
  });
});
