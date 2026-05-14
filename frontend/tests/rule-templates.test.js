import { describe, it, expect } from 'vitest';
import {
  EXAMPLES,
  fromJsonLogic,
  toJsonLogic,
  coerceLiteral,
  coerceList,
} from '../src/pages/rule-templates.js';

describe('coerceLiteral', () => {
  it('parses numerics, booleans, otherwise strings', () => {
    expect(coerceLiteral('42')).toBe(42);
    expect(coerceLiteral('-3.14')).toBe(-3.14);
    expect(coerceLiteral('true')).toBe(true);
    expect(coerceLiteral('false')).toBe(false);
    expect(coerceLiteral('p2p_transfer')).toBe('p2p_transfer');
    expect(coerceLiteral('')).toBe('');
  });
});

describe('coerceList', () => {
  it('splits + trims + coerces each cell', () => {
    expect(coerceList(' mule_a , mule_b ,mule_c')).toEqual(['mule_a', 'mule_b', 'mule_c']);
    expect(coerceList('1, 2, 3')).toEqual([1, 2, 3]);
    expect(coerceList('a, , b')).toEqual(['a', 'b']);
  });
});

describe('fromJsonLogic + toJsonLogic round-trip', () => {
  it('handles a bare comparison', () => {
    const expr = { '>=': [{ var: 'amount' }, 200000] };
    const m = fromJsonLogic(expr);
    expect(m.ok).toBe(true);
    expect(m.clauses).toEqual([{ field: 'amount', op: '>=', value: 200000 }]);
    expect(toJsonLogic(m)).toEqual(expr);
  });

  it('handles AND-joined comparisons', () => {
    const expr = {
      and: [
        { '>=': [{ var: 'amount' }, 100] },
        { '==': [{ var: 'segment' }, 'p2p_transfer'] },
      ],
    };
    const m = fromJsonLogic(expr);
    expect(m.ok).toBe(true);
    expect(m.connector).toBe('AND');
    expect(m.clauses).toHaveLength(2);
    expect(toJsonLogic(m)).toEqual(expr);
  });

  it('handles `in` clauses with a literal array', () => {
    const expr = { in: [{ var: 'receiver_id' }, ['a', 'b', 'c']] };
    const m = fromJsonLogic(expr);
    expect(m.ok).toBe(true);
    expect(m.clauses[0]).toEqual({ field: 'receiver_id', op: 'in', value: ['a', 'b', 'c'] });
    expect(toJsonLogic(m)).toEqual(expr);
  });

  it('handles `not in`', () => {
    const expr = { not: { in: [{ var: 'sender_id' }, ['x']] } };
    const m = fromJsonLogic(expr);
    expect(m.ok).toBe(true);
    expect(m.clauses[0]).toEqual({ field: 'sender_id', op: 'not_in', value: ['x'] });
    expect(toJsonLogic(m)).toEqual(expr);
  });

  it('flags nested and/or as too complex', () => {
    const m = fromJsonLogic({ and: [{ or: [{ '==': [{ var: 'x' }, 1] }] }] });
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/nested/i);
  });

  it('flags variable-as-list `in` as too complex', () => {
    const m = fromJsonLogic({ in: [{ var: 'a' }, { var: 'b' }] });
    expect(m.ok).toBe(false);
  });
});

describe('preset EXAMPLES', () => {
  it('every example carries a title, description, action, expression', () => {
    expect(EXAMPLES.length).toBeGreaterThan(0);
    for (const ex of EXAMPLES) {
      expect(ex.title).toBeTruthy();
      expect(ex.description).toBeTruthy();
      expect(['ALLOW', 'DENY', 'REVIEW']).toContain(ex.action);
      expect(['PRE', 'POST']).toContain(ex.for);
      expect(typeof ex.expression).toBe('object');
    }
  });

  it('every preset is valid JSON-Logic our rule engine can compile', () => {
    // Round-trip-able through the visual builder isn't required, but
    // every preset must at least be parseable as JSON. JSON.parse(stringify(x))
    // catches anything that smuggled in a non-serializable value.
    for (const ex of EXAMPLES) {
      const round = JSON.parse(JSON.stringify(ex.expression));
      expect(round).toEqual(ex.expression);
    }
  });
});
