import { CustomerType } from "../enums/customer-type.enum.js";
import { Decision } from "../enums/decision.enum.js";
import { DecisionSource } from "../enums/decision-source.enum.js";
import { ReasonBasis } from "../enums/reason-basis.enum.js";
import { RuleStage } from "../enums/rule-stage.enum.js";
import { TransactionType } from "../enums/transaction-type.enum.js";

export interface DeviceFingerprint {
  browser?: string;
  os?: string;
  screen_resolution?: string;
}

export interface PredictRequest {
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  // `${Enum}` rather than the enum itself so callers can pass a plain
  // "TRANSFER" without importing anything; enum members still assign.
  transaction_type: `${TransactionType}`;
  timestamp: number;
  segment?: string;

  customer_account_name?: string;
  beneficiary_account_name?: string;

  customer_dob?: string;
  customer_nationality?: string;
  customer_type?: `${CustomerType}`;
  customer_id_type?: string;
  customer_id_number?: string;
  account_age_days?: number;
  is_authenticated?: boolean;

  channel?: string;
  currency?: string;
  is_inflow?: boolean;
  is_recurring?: boolean;

  wallet_balance?: number;

  customer_latitude?: number;
  customer_longitude?: number;
  transaction_country?: string;
  destination_country?: string;
  ip_country?: string;
  transaction_lat?: number;
  transaction_lng?: number;

  ip_is_vpn?: boolean;
  device_is_trusted?: boolean;
  device_type?: string;
  session_to_txn_seconds?: number;

  agent_id?: string;
  agent_latitude?: number;
  agent_longitude?: number;
  agent_battery_level?: number;

  recipient_dob?: string;
  recipient_nationality?: string;
  recipient_id_type?: string;
  recipient_id_number?: string;
  customer_fi?: string;
  recipient_fi?: string;

  device_fingerprint?: DeviceFingerprint;
}

export interface ReasonCode {
  code: string;
  description: string;
  contribution: number;
  value: number;
  basis: `${ReasonBasis}`;
}

export interface PredictRuleHit {
  id: string;
  name: string;
  stage: `${RuleStage}`;
}

export interface PredictResponse {
  transaction_id: string;
  fraud: boolean;
  fraud_probability: number;
  decision: `${Decision}`;
  decision_source: `${DecisionSource}`;
  reason_codes: ReasonCode[];
  model_version: string;
  threshold: number;
  rule?: PredictRuleHit;
  audit_id?: string;
  latency_ms: number;
  timestamp: number;
}

export interface PredictResult {
  decision: PredictResponse;
  /** True when the server served a cached body for a replayed Idempotency-Key. */
  replayed: boolean;
  correlationId: string | null;
}
