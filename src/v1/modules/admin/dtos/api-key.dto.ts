export interface IssueApiKeyDto {
  name: string;
  tenantId?: string;
  scope?: string;
  rateLimitPerMinute?: number;
  expiresAt?: string;
}

export interface RevokeApiKeyDto {
  reason?: string;
}
