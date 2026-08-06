import { RuleContext, RuleExpression } from "./rule.types";

export const RULE_OPERATORS = [
  "var",
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "and",
  "or",
  "not",
  "in",
] as const;

/** Every `var` path an expression reads. Used by save-time validation and
 *  by the request-only classification that lets PRE rules short-circuit
 *  before the Redis feature read. */
export function collectVarPaths(expr: RuleExpression, out: Set<string> = new Set()): Set<string> {
  if (expr === null || typeof expr !== "object") return out;
  if (Array.isArray(expr)) {
    for (const e of expr) collectVarPaths(e, out);
    return out;
  }
  for (const [op, args] of Object.entries(expr as Record<string, unknown>)) {
    if (op === "var") {
      if (typeof args === "string") out.add(args);
      continue;
    }
    collectVarPaths(args as RuleExpression, out);
  }
  return out;
}

/**
 * Minimal JSON-Logic-style evaluator. Intentionally small — fraud
 * rules need predicates, comparisons, set membership, and boolean
 * combinators, nothing more. Adding arithmetic or string functions
 * is a slippery slope toward a real DSL; keep it tight.
 */
export function evaluate(expr: RuleExpression, ctx: RuleContext): boolean {
  return Boolean(evaluateAny(expr, ctx));
}

function evaluateAny(expr: RuleExpression, ctx: RuleContext): unknown {
  if (expr === null) return null;
  if (typeof expr !== "object") return expr;
  if (Array.isArray(expr)) return expr.map((e) => evaluateAny(e, ctx));

  const keys = Object.keys(expr);
  if (keys.length !== 1) {
    throw new Error(`Invalid rule expression: expected single operator, got ${keys.join(",")}`);
  }
  const op = keys[0]!;
  const args = (expr as any)[op];

  switch (op) {
    case "var":
      return resolveVar(String(args), ctx);
    case "==":
      return resolveBinary(args, ctx, (a, b) => a == b); // eslint-disable-line eqeqeq
    case "!=":
      return resolveBinary(args, ctx, (a, b) => a != b); // eslint-disable-line eqeqeq
    case ">":
      return resolveBinary(args, ctx, (a, b) => Number(a) > Number(b));
    case ">=":
      return resolveBinary(args, ctx, (a, b) => Number(a) >= Number(b));
    case "<":
      return resolveBinary(args, ctx, (a, b) => Number(a) < Number(b));
    case "<=":
      return resolveBinary(args, ctx, (a, b) => Number(a) <= Number(b));
    case "and":
      return (args as RuleExpression[]).every((e) => Boolean(evaluateAny(e, ctx)));
    case "or":
      return (args as RuleExpression[]).some((e) => Boolean(evaluateAny(e, ctx)));
    case "not":
      return !evaluateAny(args, ctx);
    case "in": {
      // Array haystacks only. A string haystack used to fall through to
      // `includes()`, turning set membership into a substring match —
      // `{"in": [{"var":"ip_country"}, "NGNE"]}` matched "GN" as readily
      // as "NG".
      const [needle, haystack] = args;
      const n = evaluateAny(needle, ctx);
      const h = evaluateAny(haystack, ctx);
      if (Array.isArray(h)) return h.some((v) => v == n); // eslint-disable-line eqeqeq
      return false;
    }
    default:
      throw new Error(`Unknown rule operator: ${op}`);
  }
}

function resolveBinary(
  args: [RuleExpression, RuleExpression],
  ctx: RuleContext,
  cmp: (a: any, b: any) => boolean
): boolean {
  const a = evaluateAny(args[0], ctx);
  const b = evaluateAny(args[1], ctx);
  return cmp(a, b);
}

function resolveVar(path: string, ctx: RuleContext): unknown {
  if (!path) return undefined;
  const parts = path.split(".");
  let cursor: any = ctx;
  for (const p of parts) {
    if (cursor == null) return undefined;
    cursor = cursor[p];
  }
  return cursor;
}
