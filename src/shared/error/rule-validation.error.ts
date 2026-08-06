import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class RuleValidationError extends AppError {
  constructor(public readonly problems: string[]) {
    super(httpStatus.BAD_REQUEST, `Invalid rule expression: ${problems.join("; ")}`);
    this.errorCode = ErrorCode.VALIDATION_ERROR;
  }
}
