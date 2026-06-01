import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class TrainingSourceUnsupportedError extends AppError {
  constructor(public readonly source: string) {
    super(
      httpStatus.NOT_IMPLEMENTED,
      `Source kind for ${source} is not yet supported; only file:// is implemented in this release`,
    );
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
