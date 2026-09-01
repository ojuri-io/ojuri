import Transport from "../http/transport.js";
import { unwrapEnvelope } from "../http/envelope.js";
import { RequestOptions } from "../client.types.js";
import { LoginInput, LoginResult } from "../types/auth.types.js";

class AuthResource {
  constructor(private readonly transport: Transport) {}

  async login(input: LoginInput, options: RequestOptions = {}): Promise<LoginResult> {
    const response = await this.transport.request<unknown>({
      method: "POST",
      path: "/v1/auth/login",
      body: input,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return unwrapEnvelope<LoginResult>(response.data);
  }
}

export default AuthResource;
