import OjuriError from "./ojuri.error.js";

class OjuriResponseError extends OjuriError {
  public readonly status: number;
  public readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export default OjuriResponseError;
