/**
 * Executor for adopter-overlay `compute` operations.
 *
 * The catalogue defines a small algebra of ops (`from_field`,
 * `equals`, `is_one_of`, `ratio`, `lookup`, `numeric_bucket`,
 * `bool_and`, `bool_or`, `from_redis`). Each op resolves to a single
 * numeric value for one feature slot.
 *
 * The executor is deliberately stateless and side-effect-free apart
 * from the cached lookup-table load: same input → same output. That
 * matters because the train-side Python mirror needs to produce
 * identical values for parity.
 */

import { ComputeOp, FeatureSpec } from "./feature-catalog.types";
import { lookupValue } from "./lookup-table";
import { safeBool, safeNumber } from "./encoders";

/**
 * Context handed to each compute call.
 *
 * - `request` is the raw `POST /v1/predict` body (treated as
 *   `Record<string, unknown>` because adopters may extend the DTO
 *   with their own fields).
 * - `redisFeatures` is the `features:{senderId}` hash already
 *   fetched by `FeatureService.getFeatures()` — passed through so a
 *   `from_redis` op resolves without re-hitting Redis.
 * - `priorFeatures` is the index→value map of catalogue features
 *   computed so far. `bool_and` / `bool_or` reference this by name.
 */
export interface ComputeContext {
  request: Record<string, unknown>;
  redisFeatures: Record<string, unknown>;
  priorFeatures: Map<string, number>;
}

export function executeComputeOp(
  spec: FeatureSpec,
  op: ComputeOp,
  ctx: ComputeContext
): number {
  switch (op.type) {
    case "from_field":
      return coerceToFeatureValue(ctx.request[op.field], spec);

    case "equals":
      return ctx.request[op.field] === op.value ? 1 : 0;

    case "not_equals":
      return ctx.request[op.field] !== op.value ? 1 : 0;

    case "is_one_of": {
      const v = ctx.request[op.field];
      return op.values.includes(v as string | number) ? 1 : 0;
    }

    case "ratio": {
      const n = safeNumber(ctx.request[op.numerator.field], 0);
      const d = safeNumber(ctx.request[op.denominator.field], 0);
      const minDenominator = op.min_denominator ?? 0;
      if (d <= minDenominator) {
        // Fall back to the per-feature default (numeric or bool).
        return spec.default === true ? 1 : spec.default === false ? 0 : Number(spec.default);
      }
      return n / d;
    }

    case "lookup": {
      const fallback =
        typeof op.default === "number"
          ? op.default
          : spec.default === true
          ? 1
          : spec.default === false
          ? 0
          : Number(spec.default);
      return lookupValue(op.table, ctx.request[op.field] as string | number | null | undefined, fallback);
    }

    case "numeric_bucket": {
      const v = safeNumber(ctx.request[op.field], 0);
      for (let i = 0; i < op.boundaries.length; i++) {
        if (v <= op.boundaries[i]) return i;
      }
      return op.boundaries.length; // overflow bucket
    }

    case "bool_and":
      return op.refs.every((r) => (ctx.priorFeatures.get(r) ?? 0) > 0) ? 1 : 0;

    case "bool_or":
      return op.refs.some((r) => (ctx.priorFeatures.get(r) ?? 0) > 0) ? 1 : 0;

    case "from_redis":
      return coerceToFeatureValue(ctx.redisFeatures[op.key], spec);

    default: {
      // Exhaustiveness check: TS narrows the union to `never` if we
      // covered every variant. Adding a new op breaks compile here.
      const _exhaustive: never = op;
      throw new Error(`unknown compute op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function coerceToFeatureValue(raw: unknown, spec: FeatureSpec): number {
  if (raw == null) {
    return spec.default === true ? 1 : spec.default === false ? 0 : Number(spec.default);
  }
  if (spec.dtype === "bool") return safeBool(raw);
  return safeNumber(raw, Number(spec.default));
}
