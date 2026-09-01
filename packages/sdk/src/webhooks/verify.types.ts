export interface WebhookVerificationInput {
  /** The plaintext secret returned once by POST /v1/admin/webhooks. */
  secret: string;
  /** Value of the `X-Webhook-Signature` header. */
  signatureHeader: string | null | undefined;
  /** The exact bytes received. A re-serialised object will not verify. */
  rawBody: string | Uint8Array;
  toleranceSeconds?: number;
}

export interface ParsedWebhookSignature {
  timestamp: number;
  signature: string;
}
