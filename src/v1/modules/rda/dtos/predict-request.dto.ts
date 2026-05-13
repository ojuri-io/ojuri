/**
 * Device fingerprint information
 */
export interface DeviceFingerprint {
  browser?: string;
  os?: string;
  screen_resolution?: string;
}

/**
 * Predict request DTO
 */
export interface PredictRequestDto {
  transaction_id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  transaction_type: "CASH_IN" | "CASH_OUT" | "PAYMENT" | "TRANSFER" | "DEBIT";
  timestamp: number;
  segment?: string;
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
  decision_source: "ML" | "PRE_RULE" | "POST_RULE";
  reason_codes: ReasonCodeDto[];
  model_version: string;
  threshold: number;
  rule?: { id: string; name: string; stage: "PRE" | "POST" };
  audit_id?: string;
  latency_ms: number;
  timestamp: number;
}
