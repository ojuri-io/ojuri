import OjuriConfigurationError from "./errors/configuration.error.js";

class Credentials {
  constructor(
    private apiKey: string | null,
    private jwt: string | null,
    private readonly tenantId: string | null
  ) {}

  setJwt(jwt: string | null): void {
    this.jwt = jwt;
  }

  setApiKey(apiKey: string | null): void {
    this.apiKey = apiKey;
  }

  predictHeaders(tenantOverride?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["X-Api-Key"] = this.apiKey;
    if (this.jwt) headers.Authorization = `Bearer ${this.jwt}`;
    const tenant = tenantOverride ?? this.tenantId;
    if (tenant) headers["X-Tenant-ID"] = tenant;
    return headers;
  }

  bearerHeaders(tenantOverride?: string): Record<string, string> {
    if (!this.jwt) {
      throw new OjuriConfigurationError(
        "This call needs a user JWT. Pass `jwt` to the client or call `login()` first."
      );
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.jwt}` };
    const tenant = tenantOverride ?? this.tenantId;
    if (tenant) headers["X-Tenant-ID"] = tenant;
    return headers;
  }
}

export default Credentials;
