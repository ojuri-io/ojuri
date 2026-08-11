export const issueApiKeyValidationRules = {
  name: "required|string|min:1|max:255",
  tenantId: "string|max:255",
  scope: "string|max:32",
  rateLimitPerMinute: "numeric|min:1|max:1000000",
  expiresAt: "string|isoDate",
};

export const issueApiKeyValidationMessages = {
  "name.required": "API key name is required",
  "rateLimitPerMinute.numeric": "rateLimitPerMinute must be a positive integer",
  "expiresAt.isoDate": "expiresAt must be an ISO 8601 date, e.g. 2026-09-10T00:00:00.000Z",
};
