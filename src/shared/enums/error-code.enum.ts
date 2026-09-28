/**
 * What a client branches on. The message is for a human reading a log, and its
 * wording is not part of the contract; this is. Several conditions share a
 * status — three different 409s and four different 503s — so the status alone
 * does not say what to do next.
 */
export enum ErrorCode {
  GENERAL_ERROR = "general_error",
  VALIDATION_ERROR = "validation_error",

  // Predict, idempotency and the decision path.
  IDEMPOTENCY_IN_FLIGHT = "idempotency_in_flight",
  IDEMPOTENCY_BODY_MISMATCH = "idempotency_body_mismatch",
  DUPLICATE_TRANSACTION = "duplicate_transaction",
  DECISION_PUBLISH_FAILED = "decision_publish_failed",
  AUDIT_PERSISTENCE_FAILED = "audit_persistence_failed",
  AUDIT_QUEUE_BACKPRESSURE = "audit_queue_backpressure",
  SERVICE_UNAVAILABLE = "service_unavailable",

  // Review.
  ALREADY_REVIEWED = "already_reviewed",

  // Training import and the chunked upload.
  TRAINING_JOB_NOT_FOUND = "training_job_not_found",
  TRAINING_PROMOTE_NOT_READY = "training_promote_not_ready",
  TRAINING_PROMOTE_DUPLICATE_STAGING = "training_promote_duplicate_staging",
  TRAINING_SOURCE_UNSUPPORTED = "training_source_unsupported",
  TRAINING_UPLOAD_NOT_FOUND = "training_upload_not_found",
  TRAINING_UPLOAD_OFFSET_MISMATCH = "training_upload_offset_mismatch",
  TRAINING_UPLOAD_SIZE_EXCEEDED = "training_upload_size_exceeded",

  INVALID_LABEL_BATCH = "invalid_label_batch",
  UNAUTHORIZED = "unauthorized",
  RULE_VALIDATION = "rule_validation",
}
