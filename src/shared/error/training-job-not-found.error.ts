import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class TrainingJobNotFoundError extends AppError {
  constructor(public readonly jobId: string) {
    super(httpStatus.NOT_FOUND, `Training job not found: ${jobId}`);
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
