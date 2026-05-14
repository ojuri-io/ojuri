/**
 * Validation rules for predict request
 */
export const predictValidationRules = {
  transaction_id: "required|uuid",
  sender_id: "required|string|min:1|max:255",
  receiver_id: "required|string|min:1|max:255",
  amount: "required|numeric|min:0.01",
  transaction_type: "required|string|in:CASH_IN,CASH_OUT,PAYMENT,TRANSFER,DEBIT",
  timestamp: "required|numeric",
  segment: "string|max:100",

  // Optional context consumed by the feature catalogue. All are
  // lightweight format checks — the catalogue's defaults cover any
  // field that's absent.
  customer_dob: "string|max:32",
  customer_nationality: "string|max:8",
  customer_type: "string|in:INDIVIDUAL,CORPORATE",
  customer_id_type: "string|max:32",
  customer_id_number: "string|max:64",
  account_age_days: "numeric|min:0",
  is_authenticated: "boolean",
  channel: "string|max:32",
  currency: "string|max:8",
  is_inflow: "boolean",
  is_recurring: "boolean",
  wallet_balance: "numeric|min:0",
  customer_latitude: "numeric|min:-90|max:90",
  customer_longitude: "numeric|min:-180|max:180",
  transaction_country: "string|max:8",
  destination_country: "string|max:8",
  ip_country: "string|max:8",
  transaction_lat: "numeric|min:-90|max:90",
  transaction_lng: "numeric|min:-180|max:180",
  ip_is_vpn: "boolean",
  device_is_trusted: "boolean",
  device_type: "string|max:32",
  session_to_txn_seconds: "numeric|min:0",
  agent_id: "string|max:64",
  agent_latitude: "numeric|min:-90|max:90",
  agent_longitude: "numeric|min:-180|max:180",
  agent_battery_level: "numeric|min:0|max:100",
  recipient_dob: "string|max:32",
  recipient_nationality: "string|max:8",
  recipient_id_type: "string|max:32",
  recipient_id_number: "string|max:64",
  customer_fi: "string|max:64",
  recipient_fi: "string|max:64",

  "device_fingerprint.browser": "string|max:255",
  "device_fingerprint.os": "string|max:255",
  "device_fingerprint.screen_resolution": "string|max:50",
};

/**
 * Custom validation messages
 */
export const predictValidationMessages = {
  "transaction_id.required": "Transaction ID is required",
  "transaction_id.uuid": "Transaction ID must be a valid UUID",
  "sender_id.required": "Sender ID is required",
  "receiver_id.required": "Receiver ID is required",
  "amount.required": "Amount is required",
  "amount.numeric": "Amount must be a number",
  "amount.min": "Amount must be greater than 0",
  "transaction_type.required": "Transaction type is required",
  "transaction_type.in": "Transaction type must be one of: CASH_IN, CASH_OUT, PAYMENT, TRANSFER, DEBIT",
  "timestamp.required": "Timestamp is required",
  "timestamp.numeric": "Timestamp must be a Unix timestamp",
};
