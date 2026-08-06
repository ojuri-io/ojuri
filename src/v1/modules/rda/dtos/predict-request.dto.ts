/**
 * Device fingerprint information
 */
export interface DeviceFingerprint {
  browser?: string;
  os?: string;
  screen_resolution?: string;
}

/**
 * Predict request DTO.
 *
 * The "core 8" fields (transaction_id … timestamp) are required and
 * have been since v1. Everything below them is optional context that
 * the feature catalogue (`models/feature-catalog.v1.json`) consumes
 * when present. Adopters with a richer payload populate the optional
 * block; minimal integrations leave them out and the catalogue falls
 * back to per-feature defaults.
 */
export interface PredictRequestDto {
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  transaction_type: "CASH_IN" | "CASH_OUT" | "PAYMENT" | "TRANSFER" | "DEBIT";
  timestamp: number;
  segment?: string;

  // ── Display names for the sender / receiver chips ─────────────
  // Account numbers (`sender_id` / `receiver_id`) are numeric in most
  // adopter payloads; these readable names are what Sentinel renders
  // on the transaction detail page.
  customer_account_name?: string;
  beneficiary_account_name?: string;

  // ── Identity context ──────────────────────────────────────────
  customer_dob?: string;             // ISO-8601 date
  customer_nationality?: string;     // ISO-3166 alpha-2
  customer_type?: "INDIVIDUAL" | "CORPORATE";
  customer_id_type?: string;         // BVN | NIN | PASSPORT | …
  customer_id_number?: string;
  account_age_days?: number;
  is_authenticated?: boolean;

  // ── Channel + currency ────────────────────────────────────────
  channel?: string;                  // USSD | MOBILE | WEB | AGENT | …
  currency?: string;                 // ISO-4217 alpha-3
  is_inflow?: boolean;
  is_recurring?: boolean;

  // ── Wallet ────────────────────────────────────────────────────
  wallet_balance?: number;

  // ── Geographic ────────────────────────────────────────────────
  customer_latitude?: number;
  customer_longitude?: number;
  transaction_country?: string;
  destination_country?: string;
  ip_country?: string;
  transaction_lat?: number;
  transaction_lng?: number;

  // ── Device / session ──────────────────────────────────────────
  ip_is_vpn?: boolean;
  device_is_trusted?: boolean;
  device_type?: string;
  session_to_txn_seconds?: number;

  // ── Agent (mobile-money) ──────────────────────────────────────
  agent_id?: string;
  agent_latitude?: number;
  agent_longitude?: number;
  agent_battery_level?: number;       // 0–100

  // ── Receiver context (used by the recipient_* features) ───────
  recipient_dob?: string;
  recipient_nationality?: string;
  recipient_id_type?: string;
  recipient_id_number?: string;
  customer_fi?: string;
  recipient_fi?: string;

  device_fingerprint?: DeviceFingerprint;
}

export interface ReasonCodeDto {
  code: string;
  description: string;
  contribution: number;
  value: number;
}

/**
 * Predict response DTO
 */
export interface PredictResponseDto {
  transaction_id: string;
  fraud: boolean;
  fraud_probability: number;
  decision: "ACCEPT" | "DECLINE" | "REVIEW";
  decision_source: "ML" | "PRE_RULE" | "POST_RULE" | "BREAKER_FALLBACK";
  reason_codes: ReasonCodeDto[];
  model_version: string;
  threshold: number;
  rule?: { id: string; name: string; stage: "PRE" | "POST" };
  audit_id?: string;
  latency_ms: number;
  timestamp: number;
}
