import { assertHeaderValue } from "./http/header-value.js";

const TENANT_ID_MAX_LENGTH = 255;

// Real #private fields, not TypeScript's compile-time `private`: these end up
// on a client that applications log and that crash reporters serialise.
class Credentials {
  #apiKey: string | null;
  readonly #tenantId: string | null;

  constructor(apiKey: string | null, tenantId: string | null) {
    this.#apiKey = apiKey === null ? null : assertHeaderValue("apiKey", apiKey, 512);
    this.#tenantId = tenantId === null ? null : assertHeaderValue("tenantId", tenantId, TENANT_ID_MAX_LENGTH);
  }

  setApiKey(apiKey: string | null): void {
    this.#apiKey = apiKey === null ? null : assertHeaderValue("apiKey", apiKey, 512);
  }

  headers(tenantOverride?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#apiKey) headers["X-Api-Key"] = this.#apiKey;
    const tenant = tenantOverride ?? this.#tenantId;
    if (tenant) {
      headers["X-Tenant-ID"] = assertHeaderValue("tenantId", tenant, TENANT_ID_MAX_LENGTH);
    }
    return headers;
  }

  toJSON(): Record<string, never> {
    return {};
  }
}

export default Credentials;
