import OjuriValidationError from "../errors/validation.error.js";

// encodeURIComponent escapes "/" but not ".", so a bare ".." would survive as a
// live traversal token between the SDK's own literal slashes.
const DOT_ONLY = /^\.+$/;

export function encodePathSegment(field: string, value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OjuriValidationError(field, `${field} must be a non-empty string`);
  }
  if (DOT_ONLY.test(value)) {
    throw new OjuriValidationError(field, `${field} must not be "${value}"`);
  }
  return encodeURIComponent(value);
}
