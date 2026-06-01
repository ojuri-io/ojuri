import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class TrainingUploadSizeExceededError extends AppError {
  constructor(public readonly limit: number) {
    super(413, `Upload exceeds the configured size limit (${limit} bytes)`);
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
