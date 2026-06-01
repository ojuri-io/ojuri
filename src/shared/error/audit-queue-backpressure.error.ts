import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class AuditQueueBackpressureError extends AppError {
  constructor(public readonly capacity: number) {
    super(
      httpStatus.SERVICE_UNAVAILABLE,
      `Audit write queue full (cap=${capacity}); rejecting predict`,
    );
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
