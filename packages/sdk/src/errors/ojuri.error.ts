// Dual ESM/CJS publishing means an app can load two copies of this package, so
// `instanceof` is unreliable across them. The registry symbol is not.
const BRAND = Symbol.for("ojuri.sdk.error");

class OjuriError extends Error {
  readonly [BRAND] = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }

  static isOjuriError(err: unknown): err is OjuriError {
    return typeof err === "object" && err !== null && BRAND in err;
  }
}

export default OjuriError;
