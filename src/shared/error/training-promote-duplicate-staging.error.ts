import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class TrainingPromoteDuplicateStagingError extends AppError {
  constructor(public readonly jobId: string) {
    super(
      httpStatus.UNPROCESSABLE_ENTITY,
      `Cannot promote job ${jobId}: staging table has duplicate transaction_id rows for this job. ` +
        `Re-upload the source CSV to create a fresh job — the existing staging data is poisoned ` +
        `and ON CONFLICT cannot reconcile it.`,
    );
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
