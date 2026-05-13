export const issueApiKeyValidationRules = {
  name: "required|string|min:1|max:255",
  tenantId: "string|max:255",
  scope: "string|max:32",
  rateLimitPerMinute: "numeric|min:1|max:1000000",
  expiresAt: "string",
};

export const issueApiKeyValidationMessages = {
  "name.required": "API key name is required",
  "rateLimitPerMinute.numeric": "rateLimitPerMinute must be a positive integer",
};
