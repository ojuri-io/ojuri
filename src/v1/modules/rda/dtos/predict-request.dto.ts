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
  device_fingerprint?: DeviceFingerprint;
}

/**
 * Predict response DTO
 */
export interface PredictResponseDto {
  transaction_id: string;
  fraud: boolean;
  fraud_probability: number;
  decision: "ACCEPT" | "DECLINE";
  latency_ms: number;
  timestamp: number;
}
