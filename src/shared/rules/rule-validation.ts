import { loadCatalog } from "@shared/features/feature-catalog";
import RuleValidationError from "@shared/error/rule-validation.error";
import { RuleExpression, RuleStage } from "./rule.types";
import { RULE_OPERATORS } from "./evaluator";

const FEATURE_PREFIX = "features.";

/**
 * Context keys a rule may read. Mirrors `PredictService.buildRuleContext`;
 * `ml_score` / `ml_decision` exist only in the POST stage.
 */
const REQUEST_VARS = [
  "transaction_id",
  "sender_id",
  "receiver_id",
  "amount",
  "transaction_type",
  "timestamp",
  "segment",
  "tenant_id",
  "ip_country",
  "transaction_country",
  "destination_country",
  "ip_is_vpn",
  "device_is_trusted",
  "is_authenticated",
  "session_to_txn_seconds",
  "account_age_days",
  "channel",
  "currency",
] as const;

const POST_ONLY_VARS = ["ml_score", "ml_decision"] as const;

export function knownVars(stage: RuleStage): Set<string> {
  const vars = new Set<string>(REQUEST_VARS);
  if (stage === "POST") for (const v of POST_ONLY_VARS) vars.add(v);
  for (const name of loadCatalog().byName.keys()) vars.add(FEATURE_PREFIX + name);
  return vars;
}

/**
 * Rejects at save time what the evaluator can only fail silently at
 * decision time: an unknown `var` path resolves to `undefined`, and
 * `undefined == undefined` makes a rule with two typo'd operands fire on
 * every transaction.
 */
export function validateExpression(expr: RuleExpression, stage: RuleStage): void {
  const problems: string[] = [];
  const allowed = knownVars(stage);
  walk(expr, allowed, problems, 0);
  if (problems.length > 0) throw new RuleValidationError(problems);
}

function walk(expr: RuleExpression, allowed: Set<string>, problems: string[], depth: number): void {
  if (depth > 32) {
    problems.push("expression nests deeper than 32 levels");
    return;
  }
  if (expr === null || typeof expr !== "object") return;
  if (Array.isArray(expr)) {
    for (const e of expr) walk(e, allowed, problems, depth + 1);
    return;
  }

  const keys = Object.keys(expr);
  if (keys.length !== 1) {
    problems.push(`expected a single operator, got [${keys.join(", ")}]`);
    return;
  }

  const op = keys[0]!;
  const args = (expr as Record<string, unknown>)[op];

  if (!(RULE_OPERATORS as readonly string[]).includes(op)) {
    problems.push(`unknown operator '${op}'`);
    return;
  }

  if (op === "var") {
    if (typeof args !== "string" || args.length === 0) {
      problems.push("'var' takes a non-empty string path");
      return;
    }
    if (!allowed.has(args)) {
      problems.push(
        args.startsWith(FEATURE_PREFIX)
          ? `unknown feature '${args.slice(FEATURE_PREFIX.length)}' — not in the feature catalogue`
          : `unknown variable '${args}'`
      );
    }
    return;
  }

  if (op === "in") {
    if (!Array.isArray(args) || args.length !== 2) {
      problems.push("'in' takes [needle, haystack]");
      return;
    }
    if (!Array.isArray(args[1])) problems.push("'in' requires an array haystack");
    walk(args[0] as RuleExpression, allowed, problems, depth + 1);
    walk(args[1] as RuleExpression, allowed, problems, depth + 1);
    return;
  }

  walk(args as RuleExpression, allowed, problems, depth + 1);
}
