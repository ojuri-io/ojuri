import { validateExpression } from "../../src/shared/rules/rule-validation";
import { collectVarPaths, evaluate } from "../../src/shared/rules/evaluator";
import RuleValidationError from "../../src/shared/error/rule-validation.error";
import { RuleContext, RuleExpression, RuleStage } from "../../src/shared/rules/rule.types";
import { TransactionType } from "../../src/shared/enums/transaction-type.enum";

const ctx: RuleContext = {
  transaction_id: "t",
  sender_id: "s",
  receiver_id: "r",
  amount: 100,
  transaction_type: TransactionType.PAYMENT,
  timestamp: 0,
};

describe("rule expression validation", () => {
  it("accepts request vars, catalogue features, and POST-only vars", () => {
    expect(() =>
      validateExpression({ ">=": [{ var: "amount" }, 1000] }, "PRE" as RuleStage)
    ).not.toThrow();
    expect(() =>
      validateExpression({ ">=": [{ var: "features.velocity_1h" }, 5] }, "POST" as RuleStage)
    ).not.toThrow();
    expect(() =>
      validateExpression({ ">=": [{ var: "ml_score" }, 0.5] }, "POST" as RuleStage)
    ).not.toThrow();
  });

  it("rejects a typo'd request var", () => {
    expect(() =>
      validateExpression({ ">=": [{ var: "ammount" }, 1000] }, "PRE" as RuleStage)
    ).toThrow(RuleValidationError);
  });

  it("rejects a feature absent from the catalogue", () => {
    expect(() =>
      validateExpression({ ">=": [{ var: "features.not_a_feature" }, 1] }, "POST" as RuleStage)
    ).toThrow(/not in the feature catalogue/);
  });

  it("rejects ml_score in the PRE stage, where it does not exist", () => {
    expect(() =>
      validateExpression({ ">=": [{ var: "ml_score" }, 0.5] }, "PRE" as RuleStage)
    ).toThrow(RuleValidationError);
  });

  it("rejects unknown operators before they reach the evaluator", () => {
    expect(() =>
      validateExpression({ "+": [{ var: "amount" }, 1] } as unknown as RuleExpression, "PRE" as RuleStage)
    ).toThrow(/unknown operator/);
  });

  // Every saved rule runs on every request, so an oversized expression
  // is a standing cost on the decision path, not just a slow save.
  it("rejects an expression with too many nodes", () => {
    const wide = { or: Array.from({ length: 400 }, () => ({ ">=": [{ var: "amount" }, 1] })) };
    expect(() => validateExpression(wide as RuleExpression, "PRE" as RuleStage)).toThrow(/nodes/);
  });

  it("rejects an oversized `in` haystack", () => {
    const huge = { in: [{ var: "sender_id" }, Array.from({ length: 500 }, (_, i) => `s${i}`)] };
    expect(() => validateExpression(huge as RuleExpression, "PRE" as RuleStage)).toThrow(/haystack/);
  });

  it("accepts nesting up to the documented depth for and/or chains", () => {
    let expr: RuleExpression = { ">=": [{ var: "amount" }, 1] };
    for (let i = 0; i < 20; i++) expr = { and: [expr] };
    expect(() => validateExpression(expr, "PRE" as RuleStage)).not.toThrow();
  });

  it("rejects nesting past the depth cap", () => {
    let expr: RuleExpression = { ">=": [{ var: "amount" }, 1] };
    for (let i = 0; i < 40; i++) expr = { not: expr };
    expect(() => validateExpression(expr, "PRE" as RuleStage)).toThrow(/nests deeper/);
  });

  it("rejects a string haystack for `in`", () => {
    expect(() =>
      validateExpression({ in: [{ var: "ip_country" }, "NGNE"] }, "PRE" as RuleStage)
    ).toThrow(/array haystack/);
  });

  // The failure that motivated save-time validation: both operands
  // resolve to undefined, `undefined == undefined` is true, and the rule
  // silently fires on every transaction.
  it("catches the two-typos-compare-equal expression that fires on everything", () => {
    const landmine: RuleExpression = { "==": [{ var: "typo_a" }, { var: "typo_b" }] };
    expect(evaluate(landmine, ctx)).toBe(true);
    expect(() => validateExpression(landmine, "PRE" as RuleStage)).toThrow(RuleValidationError);
  });
});

describe("`in` operator", () => {
  it("no longer substring-matches a string haystack", () => {
    const expr: RuleExpression = { in: [{ var: "ip_country" }, "NGNE"] };
    expect(evaluate(expr, { ...ctx, ip_country: "GN" })).toBe(false);
    expect(evaluate(expr, { ...ctx, ip_country: "NG" })).toBe(false);
  });

  it("still matches array membership", () => {
    const expr: RuleExpression = { in: [{ var: "ip_country" }, ["NG", "GH"]] };
    expect(evaluate(expr, { ...ctx, ip_country: "NG" })).toBe(true);
    expect(evaluate(expr, { ...ctx, ip_country: "KE" })).toBe(false);
  });
});

describe("collectVarPaths", () => {
  it("walks nested combinators", () => {
    const paths = collectVarPaths({
      and: [
        { ">=": [{ var: "amount" }, 1] },
        { or: [{ "==": [{ var: "features.velocity_1h" }, 2] }, { not: { var: "ip_is_vpn" } }] },
      ],
    });
    expect([...paths].sort()).toEqual(["amount", "features.velocity_1h", "ip_is_vpn"]);
  });
});
