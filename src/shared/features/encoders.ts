/**
 * Stable categorical encoders used by the feature-builder.
 *
 * These small tables turn human-readable categorical request fields
 * (`transaction_type`, `transactionChannel`, `idType`, currency code,
 * country code) into small integers that fit a `uint8` ONNX input.
 * Stability matters: changing one of these mappings is a feature-
 * schema change that must come with a catalogue version bump.
 *
 * Unknown values map to 0 — the same slot as "missing" — so an
 * adopter who passes a freshly-added enum value doesn't crash the
 * predict path. The trained model treats 0 as the default for that
 * feature index, identical to the catalogue's `default`.
 */

export function encodeTransactionType(value: string | undefined): number {
  if (!value) return 0;
  switch (value.toUpperCase()) {
    case "CASH_IN":  return 1;
    case "CASH_OUT": return 2;
    case "PAYMENT":  return 3;
    case "TRANSFER": return 4;
    case "DEBIT":    return 5;
    case "PAYOUT":   return 6;
    case "WITHDRAWAL": return 7;
    default: return 0;
  }
}

export function encodeChannel(value: string | undefined): number {
  if (!value) return 0;
  switch (value.toUpperCase()) {
    case "USSD":           return 1;
    case "MOBILE":         return 2;
    case "WEB":            return 3;
    case "AGENT":          return 4;
    case "POS":            return 5;
    case "ATM":            return 6;
    case "API":            return 7;
    default: return 0;
  }
}

/**
 * Coarse currency encoding — ISO-4217 numeric collapsed to small
 * ints so the value fits a uint8. Add more entries here when an
 * adopter needs them; bump the catalogue version when you do.
 */
export function encodeCurrency(value: string | undefined): number {
  if (!value) return 0;
  switch (value.toUpperCase()) {
    case "NGN": return 1;
    case "USD": return 2;
    case "EUR": return 3;
    case "GBP": return 4;
    case "ZAR": return 5;
    case "KES": return 6;
    case "GHS": return 7;
    default: return 0;
  }
}

export function encodeIdType(value: string | undefined): number {
  if (!value) return 0;
  switch (value.toUpperCase()) {
    case "BVN":              return 1;
    case "NIN":              return 2;
    case "PASSPORT":         return 3;
    case "DRIVERS_LICENSE":  return 4;
    case "NATIONAL_ID":      return 5;
    case "VOTERS_CARD":      return 6;
    case "OTHER_ID":         return 7;
    default: return 0;
  }
}

/**
 * Encode a country to a uint8. Uses ISO-3166 alpha-2 input and
 * collapses to a small numeric. NG is first because it's the
 * dominant nationality in this codebase's expected workload; the
 * rest follow a stable alphabetical ordering for the African
 * countries we expect, then "OTHER" for everything else.
 */
const COUNTRY_TO_CODE: ReadonlyMap<string, number> = new Map([
  ["NG", 1], ["GH", 2], ["KE", 3], ["ZA", 4], ["EG", 5],
  ["US", 6], ["GB", 7], ["DE", 8], ["FR", 9], ["IN", 10],
  ["CN", 11], ["AE", 12],
]);

export function encodeCountry(value: string | undefined): number {
  if (!value) return 0;
  return COUNTRY_TO_CODE.get(value.toUpperCase()) ?? 255; // 255 = OTHER
}

/**
 * Encode device type. Same convention as channel.
 */
export function encodeDeviceType(value: string | undefined): number {
  if (!value) return 0;
  switch (value.toUpperCase()) {
    case "MOBILE":          return 1;
    case "WEB":             return 2;
    case "USSD":            return 3;
    case "POS":             return 4;
    case "AGENT_TERMINAL":  return 5;
    case "ATM":             return 6;
    default: return 0;
  }
}

/**
 * Common categorical/scalar tools used by compute ops.
 */
export function safeNumber(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return fallback;
}

export function safeBool(value: unknown): 0 | 1 {
  if (value == null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value > 0 ? 1 : 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "yes" || v === "y" || v === "1" ? 1 : 0;
  }
  return 0;
}

/**
 * Haversine distance in km between two (lat, lng) pairs.
 * Returns 0 when either coordinate pair is missing or invalid.
 */
export function haversineKm(
  lat1: number | undefined,
  lng1: number | undefined,
  lat2: number | undefined,
  lng2: number | undefined
): number {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return 0;
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return 0;
  }
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Whole days between an ISO date string and `now`. Returns 0 on
 * unparseable / missing input — the catalogue defines that as the
 * "unknown" slot for *_age_days features.
 */
export function ageDays(iso: string | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const days = Math.floor((now - t) / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}
