import OjuriConfigurationError from "./errors/configuration.error.js";

// Real #private fields, not TypeScript's compile-time `private`: these end up
// on a client that applications log and that crash reporters serialise.
class Credentials {
  #apiKey: string | null;
  #jwt: string | null;
  readonly #tenantId: string | null;

  constructor(apiKey: string | null, jwt: string | null, tenantId: string | null) {
    this.#apiKey = apiKey;
    this.#jwt = jwt;
    this.#tenantId = tenantId;
  }

  setJwt(jwt: string | null): void {
    this.#jwt = jwt;
  }

  setApiKey(apiKey: string | null): void {
    this.#apiKey = apiKey;
  }

  predictHeaders(tenantOverride?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#apiKey) headers["X-Api-Key"] = this.#apiKey;
    if (this.#jwt) headers.Authorization = `Bearer ${this.#jwt}`;
    const tenant = tenantOverride ?? this.#tenantId;
    if (tenant) headers["X-Tenant-ID"] = tenant;
    return headers;
  }

  bearerHeaders(tenantOverride?: string): Record<string, string> {
    if (!this.#jwt) {
      throw new OjuriConfigurationError(
        "This call needs a user JWT. Pass `jwt` to the client or call `login()` first."
      );
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#jwt}` };
    const tenant = tenantOverride ?? this.#tenantId;
    if (tenant) headers["X-Tenant-ID"] = tenant;
    return headers;
  }

  toJSON(): Record<string, never> {
    return {};
  }
}

export default Credentials;
