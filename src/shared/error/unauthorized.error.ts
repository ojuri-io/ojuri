import httpStatus from "http-status";
import AppError from "./app.error";

export default class UnauthorizedError extends AppError {
  constructor(message?: string) {
    super(httpStatus.UNAUTHORIZED, message ?? "You are not authorized to perform this action");
  }
}
