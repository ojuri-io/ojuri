import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class TrainingUploadNotFoundError extends AppError {
  constructor(public readonly uploadId: string) {
    super(httpStatus.NOT_FOUND, `Training upload session not found: ${uploadId}`);
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
