import { RuleContext, RuleExpression } from "./rule.types";

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
      const [needle, haystack] = args;
      const n = evaluateAny(needle, ctx);
      const h = evaluateAny(haystack, ctx);
      if (Array.isArray(h)) return h.some((v) => v == n); // eslint-disable-line eqeqeq
      if (typeof h === "string") return h.includes(String(n));
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
