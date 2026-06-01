import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class DuplicateTransactionError extends AppError {
  constructor(public readonly transactionId: string) {
    super(httpStatus.CONFLICT, `Duplicate transaction_id for tenant: ${transactionId}`);
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
