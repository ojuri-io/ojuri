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
