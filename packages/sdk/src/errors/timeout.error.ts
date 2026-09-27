import OjuriError from "./ojuri.error.js";

class OjuriTimeoutError extends OjuriError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
  }
}

export default OjuriTimeoutError;
