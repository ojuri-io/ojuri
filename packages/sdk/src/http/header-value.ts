import OjuriValidationError from "../errors/validation.error.js";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export function assertHeaderValue(field: string, value: string, maxLength: number): string {
  if (value.length === 0 || value.length > maxLength) {
    throw new OjuriValidationError(field, `${field} must be 1-${maxLength} characters`);
  }
  // fetch throws a bare TypeError on these, which the transport would otherwise
  // rewrap as a retryable network failure and burn the whole retry budget on.
  if (CONTROL_CHARACTERS.test(value)) {
    throw new OjuriValidationError(field, `${field} must not contain control characters`);
  }
  return value;
}
