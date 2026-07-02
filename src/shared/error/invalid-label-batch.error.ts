import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class InvalidLabelBatchError extends AppError {
  constructor(public readonly errors: string[]) {
    super(httpStatus.BAD_REQUEST, `Invalid label batch: ${errors.slice(0, 3).join("; ")}`);
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
