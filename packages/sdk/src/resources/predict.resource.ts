import { randomUUID } from "node:crypto";
import Credentials from "../credentials.js";
import OjuriValidationError from "../errors/validation.error.js";
import Transport from "../http/transport.js";
import { PredictOptions } from "../client.types.js";
import { PredictRequest, PredictResponse, PredictResult } from "../types/predict.types.js";

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const TRANSACTION_ID_MIN_LENGTH = 10;
const TRANSACTION_ID_MAX_LENGTH = 255;

class PredictResource {
  constructor(
    private readonly transport: Transport,
    private readonly credentials: Credentials,
    private readonly autoIdempotencyKey: boolean
  ) {}

  async create(request: PredictRequest, options: PredictOptions = {}): Promise<PredictResult> {
    assertTransactionId(request.transaction_id);
    const idempotencyKey = this.resolveIdempotencyKey(options.idempotencyKey);

    const headers = this.credentials.predictHeaders(options.tenantId);
    // Generated once per call, not per attempt — a retry has to replay the
    // first attempt's decision rather than land as a fresh transaction.
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (options.correlationId) headers["X-Correlation-ID"] = options.correlationId;

    const response = await this.transport.request<PredictResponse>({
      method: "POST",
      path: "/v1/predict",
      body: request,
      headers,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    return {
      decision: response.data,
      replayed: response.headers.get("Idempotency-Replay") === "true",
      correlationId: response.headers.get("X-Correlation-ID"),
    };
  }

  private resolveIdempotencyKey(explicit?: string): string | null {
    if (explicit === undefined) return this.autoIdempotencyKey ? randomUUID() : null;
    if (explicit.length === 0 || explicit.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new OjuriValidationError(
        "idempotencyKey",
        `idempotencyKey must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} characters`
      );
    }
    return explicit;
  }
}

// The server rejects these outright; catching them here saves a round trip
// that would otherwise surface as an opaque 400.
function assertTransactionId(transactionId: string): void {
  if (
    transactionId.length < TRANSACTION_ID_MIN_LENGTH ||
    transactionId.length > TRANSACTION_ID_MAX_LENGTH
  ) {
    throw new OjuriValidationError(
      "transaction_id",
      `transaction_id must be ${TRANSACTION_ID_MIN_LENGTH}-${TRANSACTION_ID_MAX_LENGTH} characters`
    );
  }
}

export default PredictResource;
