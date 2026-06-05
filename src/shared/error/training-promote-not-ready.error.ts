import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";
import { TrainingJobStatus } from "@shared/enums/training-job-status.enum";

export default class TrainingPromoteNotReadyError extends AppError {
  constructor(
    public readonly jobId: string,
    public readonly currentStatus: TrainingJobStatus,
  ) {
    super(
      httpStatus.CONFLICT,
      `Cannot promote job ${jobId}: current status is ${currentStatus}, must be COMPLETED. ` +
        `If the import worker is still running this will clear shortly; refresh the page.`,
    );
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
