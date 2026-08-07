import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class DecisionPublishError extends AppError {
  constructor(public readonly transactionId: string) {
    super(
      httpStatus.SERVICE_UNAVAILABLE,
      `Decision could not be durably published for transaction: ${transactionId}`
    );
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
