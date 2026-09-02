import Transport from "../http/transport.js";
import { unwrapEnvelope } from "../http/envelope.js";
import OjuriResponseError from "../errors/response.error.js";
import { RequestOptions } from "../client.types.js";
import { LoginInput, LoginResult } from "../types/auth.types.js";

class AuthResource {
  constructor(private readonly transport: Transport) {}

  async login(input: LoginInput, options: RequestOptions = {}): Promise<LoginResult> {
    const response = await this.transport.request<unknown>({
      method: "POST",
      path: "/v1/auth/login",
      body: input,
      retryable: false,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    const result = unwrapEnvelope<LoginResult>(response.data);
    assertToken(result, response.status);
    return result;
  }
}

// unwrapEnvelope is an unchecked cast. Without this the client would store an
// undefined JWT and the predict path — where headers are optional — would go
// out unauthenticated instead of failing.
function assertToken(result: LoginResult, status: number): void {
  if (typeof result?.token !== "string" || result.token.length === 0) {
    throw new OjuriResponseError("Login response did not contain a token", status, result);
  }
}

export default AuthResource;
