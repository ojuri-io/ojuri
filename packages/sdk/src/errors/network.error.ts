import OjuriError from "./ojuri.error.js";

class OjuriNetworkError extends OjuriError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

export default OjuriNetworkError;
