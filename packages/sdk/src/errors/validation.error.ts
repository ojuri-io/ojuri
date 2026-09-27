import OjuriError from "./ojuri.error.js";

class OjuriValidationError extends OjuriError {
  public readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export default OjuriValidationError;
