import OjuriConfigurationError from "./errors/configuration.error.js";
import { assertHeaderValue } from "./http/header-value.js";

// Real #private fields, not TypeScript's compile-time `private`: these end up
// on a client that applications log and that crash reporters serialise.
class Credentials {
  #apiKey: string | null;
  #jwt: string | null;
  readonly #tenantId: string | null;
  #issuedTicket = 0;
  #appliedTicket = 0;

  constructor(apiKey: string | null, jwt: string | null, tenantId: string | null) {
    this.#apiKey = apiKey;
    this.#jwt = jwt;
    this.#tenantId = tenantId;
  }

  setJwt(jwt: string | null): void {
    this.#jwt = jwt;
    this.#appliedTicket = ++this.#issuedTicket;
  }

  setApiKey(apiKey: string | null): void {
    this.#apiKey = apiKey;
  }

  beginLogin(): number {
    return ++this.#issuedTicket;
  }

  // Concurrent logins resolve out of order; the token minted last is the one
  // that lives longest, so an older response must not overwrite it.
  completeLogin(ticket: number, jwt: string): void {
    if (ticket < this.#appliedTicket) return;
    this.#jwt = jwt;
    this.#appliedTicket = ticket;
  }

  predictHeaders(tenantOverride?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.#apiKey) headers["X-Api-Key"] = this.#apiKey;
    if (this.#jwt) headers.Authorization = `Bearer ${this.#jwt}`;
    this.applyTenant(headers, tenantOverride);
    return headers;
  }

  bearerHeaders(tenantOverride?: string): Record<string, string> {
    if (!this.#jwt) {
      throw new OjuriConfigurationError(
        "This call needs a user JWT. Pass `jwt` to the client or call `login()` first."
      );
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#jwt}` };
    this.applyTenant(headers, tenantOverride);
    return headers;
  }

  toJSON(): Record<string, never> {
    return {};
  }

  private applyTenant(headers: Record<string, string>, tenantOverride?: string): void {
    const tenant = tenantOverride ?? this.#tenantId;
    if (tenant) headers["X-Tenant-ID"] = assertHeaderValue("tenantId", tenant);
  }
}

export default Credentials;
