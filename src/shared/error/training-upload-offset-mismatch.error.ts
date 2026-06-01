import httpStatus from "http-status";
import AppError from "./app.error";
import { ErrorCode } from "@shared/enums/error-code.enum";

export default class TrainingUploadOffsetMismatchError extends AppError {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(
      httpStatus.CONFLICT,
      `Chunk offset mismatch: expected ${expected}, got ${actual}`,
    );
    this.errorCode = ErrorCode.GENERAL_ERROR;
  }
}
