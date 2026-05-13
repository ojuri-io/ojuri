import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class ServiceUnavailableError extends AppError {
  constructor(message?: string) {
    super(httpStatus.SERVICE_UNAVAILABLE, message ?? "We are unable to process this request. Please try again.");

    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
