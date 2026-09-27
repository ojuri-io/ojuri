import { randomUUID } from "node:crypto";
import Credentials from "../credentials.js";
import OjuriResponseError from "../errors/response.error.js";
import OjuriValidationError from "../errors/validation.error.js";
import Transport from "../http/transport.js";
import { assertHeaderValue } from "../http/header-value.js";
import { PredictOptions } from "../client.types.js";
import { PredictRequest, PredictResponse, PredictResult } from "../types/predict.types.js";

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const TRANSACTION_ID_MIN_LENGTH = 10;
const TRANSACTION_ID_MAX_LENGTH = 255;
// The server stores `req-${correlationId}` in a varchar(255) column, and a
// rejected audit batch discards every row in the flush, not just this one.
const CORRELATION_ID_MAX_LENGTH = 251;

class PredictResource {
  constructor(
    private readonly transport: Transport,
    private readonly credentials: Credentials,
    private readonly autoIdempotencyKey: boolean
  ) {}

  async create(request: PredictRequest, options: PredictOptions = {}): Promise<PredictResult> {
    assertTransactionId(request.transaction_id);
    const idempotencyKey = this.resolveIdempotencyKey(options.idempotencyKey);

    const headers = this.credentials.headers(options.tenantId);
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (options.correlationId) {
      headers["X-Correlation-ID"] = assertHeaderValue(
        "correlationId",
        options.correlationId,
        CORRELATION_ID_MAX_LENGTH
      );
    }

    const response = await this.transport.request<PredictResponse>({
      method: "POST",
      path: "/v1/predict",
      body: request,
      headers,
      // Without a key a replay lands as a fresh transaction, not a replay.
      retryable: idempotencyKey !== null,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    assertDecision(response.data, response.status);

    return {
      decision: response.data,
      replayed: response.headers.get("Idempotency-Replay") === "true",
      correlationId: response.headers.get("X-Correlation-ID"),
    };
  }

  private resolveIdempotencyKey(explicit?: string): string | null {
    if (explicit === undefined) return this.autoIdempotencyKey ? randomUUID() : null;
    return assertHeaderValue("idempotencyKey", explicit, IDEMPOTENCY_KEY_MAX_LENGTH);
  }
}

function assertDecision(body: PredictResponse, status: number): void {
  if (typeof body?.decision !== "string") {
    throw new OjuriResponseError("Predict response did not contain a decision", status, body);
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
