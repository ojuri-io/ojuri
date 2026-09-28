export enum PredictErrorCode {
  IDEMPOTENCY_IN_FLIGHT = "idempotency_in_flight",
  IDEMPOTENCY_BODY_MISMATCH = "idempotency_body_mismatch",
  DUPLICATE_TRANSACTION = "duplicate_transaction",
}
