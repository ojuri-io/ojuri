/**
 * Catalogue-driven feature builder.
 *
 * Turns a `(request, redis snapshot)` pair into the
 * `Float32Array(catalogue.inputDimension)` that the ONNX model
 * consumes. The order is the catalogue's `index`, so feature
 * positions match exactly what MLA trained against.
 *
 * Split into two phases:
 *
 *   1. **Base features (indices 0-63)** — each has a hand-written
 *      resolver below keyed by `name`. The resolvers know how to
 *      pull values from Redis (`paa:redis`), the request body
 *      (`rda:request`), or compute them from request fields
 *      (`rda:derived`). When an input is missing the catalogue's
 *      `default` is used.
 *
 *   2. **Adopter features (indices 64+)** — evaluated by the
 *      compute-op executor in catalogue order. Earlier features are
 *      available to later ones via `priorFeatures` so `bool_and` /
 *      `bool_or` can compose.
 *
 * The legacy 12-position enrichment in `predict.service.ts` is
 * retired by this builder — `amount`, `transaction_type_code`, and
 * the time features are catalogue features 26, 28, 58-62.
 */

import { ResolvedCatalog, FeatureSpec } from "./feature-catalog.types";
import { executeComputeOp, ComputeContext } from "./compute-op-executor";
import {
  ageDays,
  encodeChannel,
  encodeCountry,
  encodeCurrency,
  encodeDeviceType,
  encodeIdType,
  encodeTransactionType,
  haversineKm,
  safeBool,
  safeNumber,
} from "./encoders";
import { lookupValue } from "./lookup-table";

export interface BuildResult {
  vector: Float32Array;
  /** Catalogue features by name → resolved numeric value. Used for
   * the audit log's `featuresSnapshot` and reason codes. */
  snapshot: Record<string, number>;
}

/**
 * Build the feature vector. `redisFeatures` is the `features:{senderId}`
 * Redis hash already fetched by `FeatureService.getFeatures()` —
 * passed in so this function doesn't re-hit Redis.
 */
export function buildFeatures(
  catalog: ResolvedCatalog,
  request: Record<string, unknown>,
  redisFeatures: Record<string, unknown>,
  now = Date.now()
): BuildResult {
  const vector = new Float32Array(catalog.inputDimension);
  const snapshot: Record<string, number> = {};
  const priorFeatures = new Map<string, number>();

  for (const spec of catalog.features) {
    const value = spec.compute
      ? executeComputeOp(spec, spec.compute, {
          request,
          redisFeatures,
          priorFeatures,
        } satisfies ComputeContext)
      : resolveBaseFeature(spec, request, redisFeatures, now);

    vector[spec.index] = value;
    snapshot[spec.name] = value;
    priorFeatures.set(spec.name, value);
  }

  return { vector, snapshot };
}

// ─── base-feature resolvers ───────────────────────────────────────

function resolveBaseFeature(
  spec: FeatureSpec,
  request: Record<string, unknown>,
  redis: Record<string, unknown>,
  now: number
): number {
  // `paa:redis` features: the Redis hash key matches the catalogue
  // name. PAA writes these directly. Missing key → catalogue default.
  if (spec.source === "paa:redis") {
    const raw = redis[spec.name];
    if (raw == null || raw === "") return numericDefault(spec);
    return spec.dtype === "bool" ? safeBool(raw) : safeNumber(raw, numericDefault(spec));
  }

  // `rda:request` — direct field by snake-case name. Boolean fields
  // tolerate "true"/"yes"/1 inputs.
  if (spec.source === "rda:request") {
    return resolveRequestField(spec, request);
  }

  // `rda:derived` — hand-written below by name.
  if (spec.source === "rda:derived") {
    return resolveDerived(spec, request, redis, now);
  }

  return numericDefault(spec);
}

function resolveRequestField(spec: FeatureSpec, request: Record<string, unknown>): number {
  switch (spec.name) {
    case "amount":
      return safeNumber(request.amount, numericDefault(spec));
    case "is_inflow":
      // Either an explicit `is_inflow` bool, or `transaction_type === CASH_IN`.
      if (request.is_inflow !== undefined) return safeBool(request.is_inflow);
      return String(request.transaction_type).toUpperCase() === "CASH_IN" ? 1 : 0;
    case "is_recurring":
      return safeBool(request.is_recurring);
    case "customer_is_corporate":
      return String(request.customer_type ?? "").toUpperCase() === "CORPORATE" ? 1 : 0;
    case "is_authenticated":
      return safeBool(request.is_authenticated);
    case "ip_is_vpn":
      return safeBool(request.ip_is_vpn);
    case "device_is_trusted":
      return safeBool(request.device_is_trusted);
    case "session_to_txn_seconds":
      return safeNumber(request.session_to_txn_seconds, numericDefault(spec));
    default:
      // Generic: snake_case field → numeric.
      return safeNumber(request[spec.name], numericDefault(spec));
  }
}

function resolveDerived(
  spec: FeatureSpec,
  request: Record<string, unknown>,
  redis: Record<string, unknown>,
  now: number
): number {
  switch (spec.name) {
    // ── pair-wise ──────────────────────────────────────────────
    case "pair_amount_ratio_to_pair_mean": {
      const amount = safeNumber(request.amount, 0);
      const mean = safeNumber(redis.pair_amount_mean_30d, 0);
      return mean > 0 ? amount / mean : 1;
    }

    // ── transaction ────────────────────────────────────────────
    case "amount_zscore_vs_sender": {
      const amount = safeNumber(request.amount, 0);
      const mean = safeNumber(redis.amount_mean_30d, 0);
      const std = safeNumber(redis.amount_std_30d, 0);
      return std > 0 ? (amount - mean) / std : 0;
    }
    case "transaction_type_code":
      return encodeTransactionType(request.transaction_type as string | undefined);
    case "channel_code":
      return encodeChannel(request.channel as string | undefined);
    case "is_cross_border": {
      const home = String(request.customer_nationality ?? "").toUpperCase();
      const txn = String(request.transaction_country ?? home).toUpperCase();
      return home && txn && home !== txn ? 1 : 0;
    }
    case "currency_code":
      return encodeCurrency(request.currency as string | undefined);

    // ── identity ───────────────────────────────────────────────
    case "customer_age_days":
      return ageDays(request.customer_dob as string | undefined, now);
    case "account_age_days":
      return safeNumber(request.account_age_days, numericDefault(spec));
    case "has_kyc_id":
      return request.customer_id_type && request.customer_id_number ? 1 : 0;
    case "id_type_code":
      return encodeIdType(request.customer_id_type as string | undefined);

    // ── receiver ───────────────────────────────────────────────
    case "recipient_has_kyc_id":
      return request.recipient_id_type && request.recipient_id_number ? 1 : 0;
    case "recipient_same_fi": {
      const a = String(request.customer_fi ?? "");
      const b = String(request.recipient_fi ?? "");
      return a && b && a === b ? 1 : 0;
    }
    case "recipient_nationality_match": {
      const a = String(request.customer_nationality ?? "").toUpperCase();
      const b = String(request.recipient_nationality ?? a).toUpperCase();
      return a && b && a === b ? 1 : 0;
    }
    case "recipient_age_days":
      return ageDays(request.recipient_dob as string | undefined, now);

    // ── geographic ─────────────────────────────────────────────
    case "customer_to_txn_distance_km":
      return haversineKm(
        safeNumber(request.customer_latitude, NaN),
        safeNumber(request.customer_longitude, NaN),
        safeNumber(request.transaction_lat, NaN),
        safeNumber(request.transaction_lng, NaN)
      );
    case "customer_to_agent_distance_km":
      return haversineKm(
        safeNumber(request.customer_latitude, NaN),
        safeNumber(request.customer_longitude, NaN),
        safeNumber(request.agent_latitude, NaN),
        safeNumber(request.agent_longitude, NaN)
      );
    case "ip_country_mismatch": {
      const home = String(request.customer_nationality ?? "").toUpperCase();
      const ip = String(request.ip_country ?? home).toUpperCase();
      return home && ip && home !== ip ? 1 : 0;
    }
    case "txn_country_risk_band":
      return lookupValue(
        "country_risk.json",
        request.transaction_country as string | undefined,
        numericDefault(spec)
      );
    case "is_cross_border_dest": {
      const txn = String(request.transaction_country ?? "").toUpperCase();
      const dst = String(request.destination_country ?? txn).toUpperCase();
      return txn && dst && txn !== dst ? 1 : 0;
    }
    case "sender_country_code":
      return encodeCountry(request.customer_nationality as string | undefined);

    // ── device ────────────────────────────────────────────────
    case "device_type_code":
      return encodeDeviceType(request.device_type as string | undefined);
    case "is_agent_assisted":
      return request.agent_id ? 1 : 0;
    case "agent_battery_low": {
      const level = safeNumber(request.agent_battery_level, 100);
      return level > 0 && level < 20 ? 1 : 0;
    }

    // ── calendar ───────────────────────────────────────────────
    case "hour_of_day":
      return eventDate(request, now).getUTCHours();
    case "day_of_week":
      return eventDate(request, now).getUTCDay();
    case "is_weekend": {
      const d = eventDate(request, now).getUTCDay();
      return d === 0 || d === 6 ? 1 : 0;
    }
    case "is_payday_window": {
      const day = eventDate(request, now).getUTCDate();
      // 25th + 30th are common NG payroll dates; widen ±2 days each
      // side to catch the period of elevated legit activity.
      return (day >= 23 && day <= 27) || day >= 28 ? 1 : 0;
    }
    case "is_off_hours": {
      const h = eventDate(request, now).getUTCHours();
      return h <= 5 || h === 23 ? 1 : 0;
    }

    default:
      return numericDefault(spec);
  }
}

// request.timestamp is Unix MILLISECONDS per the predict DTO contract
// (and what PAA/MLA consume). An earlier version multiplied it by 1000
// as if it were seconds, which scrambled every calendar feature.
function eventDate(request: Record<string, unknown>, now: number): Date {
  return new Date(safeNumber(request.timestamp, now));
}

function numericDefault(spec: FeatureSpec): number {
  if (typeof spec.default === "boolean") return spec.default ? 1 : 0;
  return Number(spec.default);
}
