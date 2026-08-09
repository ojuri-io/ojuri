import { loadCatalog } from "@shared/features/feature-catalog";
import RuleValidationError from "@shared/error/rule-validation.error";
import { RuleExpression, RuleStage } from "./rule.types";
import { RULE_OPERATORS } from "./evaluator";

const FEATURE_PREFIX = "features.";
const MAX_DEPTH = 32;
const MAX_NODES = 500;
const MAX_HAYSTACK = 200;

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
  walk(expr, knownVars(stage), problems, 0, { nodes: 0 });
  if (problems.length > 0) throw new RuleValidationError(problems);
}

function walk(
  expr: RuleExpression,
  allowed: Set<string>,
  problems: string[],
  depth: number,
  budget: { nodes: number }
): void {
  // Every saved rule is re-evaluated on each request, so an oversized
  // expression is a standing cost on the decision path, not just a
  // slow save.
  if (++budget.nodes > MAX_NODES) {
    problems.push(`expression exceeds ${MAX_NODES} nodes`);
    return;
  }
  if (depth > MAX_DEPTH) {
    problems.push(`expression nests deeper than ${MAX_DEPTH} levels`);
    return;
  }
  if (expr === null || typeof expr !== "object") return;
  // An argument list is a container, not a nesting level — counting it
  // would make `and`/`or` hit the cap at half the stated depth.
  if (Array.isArray(expr)) {
    for (const e of expr) walk(e, allowed, problems, depth, budget);
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
    if (!Array.isArray(args[1])) {
      problems.push("'in' requires an array haystack");
    } else if (args[1].length > MAX_HAYSTACK) {
      problems.push(`'in' haystack exceeds ${MAX_HAYSTACK} entries`);
    }
    walk(args[0] as RuleExpression, allowed, problems, depth + 1, budget);
    walk(args[1] as RuleExpression, allowed, problems, depth + 1, budget);
    return;
  }

  walk(args as RuleExpression, allowed, problems, depth + 1, budget);
}
