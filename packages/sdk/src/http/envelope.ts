import { SuccessEnvelope } from "../types/envelope.types.js";

export function unwrapEnvelope<T>(body: unknown): T {
  if (isSuccessEnvelope<T>(body)) return body.data;
  return body as T;
}

function isSuccessEnvelope<T>(body: unknown): body is SuccessEnvelope<T> {
  return typeof body === "object" && body !== null && "status" in body && "data" in body;
}
