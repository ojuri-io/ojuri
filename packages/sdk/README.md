# @ojuri/sdk

Typed Node client for the predict path of [Ojuri](https://github.com/ojuri-io/ojuri),
plus verification for the webhooks it sends you.

Zero runtime dependencies. Ships ESM and CommonJS. Node 18+.

```bash
npm install @ojuri/sdk
```

## Scope

This package covers the two places an adopter's code meets Ojuri: the
synchronous `POST /v1/predict` call on the authorization path, and the inbound
webhook. It does **not** wrap the audit reads, the review queue, the override
endpoint, or the FIA report API — those are the Sentinel dashboard's surface and
it calls them directly. Query `decisionAuditLog`, or use Sentinel.

## Quickstart

```ts
import { OjuriClient } from "@ojuri/sdk";

const ojuri = new OjuriClient({
  baseUrl: "https://rda.example.com",
  apiKey: process.env.OJURI_API_KEY,
});

const { decision } = await ojuri.predict({
  transaction_id: "your-own-id-min-10-chars",
  sender_id: "acct-123",
  receiver_id: "acct-456",
  amount: 50000,
  transaction_type: "TRANSFER",
  timestamp: Date.now(),
}, { idempotencyKey: "your-own-id-min-10-chars" });

if (decision.decision === "DECLINE") {
  block(decision.reason_codes);
}
```

Those six fields are the only required ones. Every optional field in
[`docs/PREDICT-API.md`](../../docs/PREDICT-API.md) — identity, device,
geography, channel — only sharpens the score; the feature catalogue substitutes
defaults for anything you omit.

The decision is `ACCEPT`, `DECLINE`, or `REVIEW`. Not `APPROVE`.

## Degraded decisions

`decision_source` tells you how the decision was reached. One value needs
handling of its own:

```ts
if (decision.decision_source === "BREAKER_FALLBACK") {
  // Inference never ran — the circuit breaker opened. This REVIEW carries
  // no model signal, so fall back to your own check rather than trusting it.
}
```

## Configuration

```ts
new OjuriClient({
  baseUrl: "https://rda.example.com",  // required, absolute http(s)
  apiKey: "fdk_<prefix>_<secret>",
  tenantId: "acme",
  timeoutMs: 10_000,
  deadlineMs: 30_000,
  maxRetries: 2,
  retryBaseDelayMs: 200,
  autoIdempotencyKey: false,
  fetch: customFetch,                  // defaults to global fetch
});
```

`deadlineMs` caps total wall-clock time per call including every retry and
backoff, defaulting to `timeoutMs * (maxRetries + 1)`. Without it a client
reading as "10 seconds" can block far longer once backoff is counted.

## Idempotency and retries

**Pass your own `idempotencyKey`** — your `transaction_id`, or your PSP
reference. A key's whole value is that *you* reuse it across your own retries,
which the SDK cannot do on your behalf. With a key, a retry replays the original
decision. Without one, the server's per-transaction guard rejects a duplicate
`transaction_id` with a 409, which is also a correct answer.

`autoIdempotencyKey: true` generates a UUID per call. It protects only this
client's internal retry loop and defeats the server's duplicate detection for
your retries, so it is off by default.

A call is retried only when it carries an idempotency key. Retryable failures
are `408`, `429`, `502`, `503`, `504`, network failures, timeouts, and any 4xx
carrying `Retry-After` (which is how RDA marks a key still in flight). Backoff
is exponential with full jitter; a `Retry-After` value is honoured as given, and
if it does not fit inside the remaining deadline the call fails with the
directive attached rather than retrying earlier than instructed.

`500` is never retried, even with a `Retry-After` header: the server handled the
request and failed inside it, so a blind retry can duplicate effects the client
cannot see.

Pass an `AbortSignal` to cancel. A signal already aborted stops the call before
it is sent, and aborting during a backoff wait ends the retry loop immediately.
Cancellation surfaces as the runtime's own `AbortError`, not an `OjuriError`.

## Errors

Every failure the SDK raises is an `OjuriError` subclass. Cancellation is the
one exception, as above.

| Class | Raised when |
|---|---|
| `OjuriApiError` | Non-2xx response. Carries `status`, `errors[]`, `correlationId`, `retryAfterSeconds`, `body`. |
| `OjuriResponseError` | The server answered with something unusable — a non-JSON 200, or a body with no `decision`. |
| `OjuriTimeoutError` | The per-attempt timeout or the overall deadline elapsed. |
| `OjuriNetworkError` | The request never reached the server. |
| `OjuriValidationError` | Client-side input rejected before sending. |
| `OjuriConfigurationError` | A `baseUrl` that is not an absolute http(s) URL, or no global `fetch`. |

Use the static predicates rather than `instanceof`. Publishing both ESM and CJS
means an app can load two copies of this package, and `instanceof` fails across
them:

```ts
import { OjuriApiError } from "@ojuri/sdk";

try {
  await ojuri.predict(request, { idempotencyKey: txn.reference });
} catch (err) {
  if (OjuriApiError.isOjuriApiError(err) && err.status === 409) {
    // this transaction_id was already scored
  }
  throw err;
}
```

## Client-side validation

Rejected before a request is sent, so you get a named field instead of an
opaque 400: `transaction_id` outside 10-255 characters, an `idempotencyKey`
over 128 characters, a `correlationId` over 251 (the server prefixes `req-` and
stores it in a `varchar(255)`), any of those containing control characters, and
a request body that is not JSON-serialisable.

## Webhook verification

Verify against the **raw** request body. A re-serialised object will not match.

```ts
import { verifyWebhookSignature } from "@ojuri/sdk";
import type { WebhookEnvelope } from "@ojuri/sdk";

app.post("/hooks/ojuri", express.raw({ type: "application/json" }), (req, res) => {
  const ok = verifyWebhookSignature({
    secret: process.env.OJURI_WEBHOOK_SECRET!,
    signatureHeader: req.header("X-Webhook-Signature"),
    rawBody: req.body,
  });
  if (!ok) return res.sendStatus(401);

  const envelope: WebhookEnvelope = JSON.parse(req.body.toString("utf8"));
  switch (envelope.event) {
    case "decision.created":    return handle(envelope.data.audit_id), res.sendStatus(204);
    case "decision.overridden": return handle(envelope.data.reviewer), res.sendStatus(204);
    default:                    return res.sendStatus(204);
  }
});
```

`WebhookEnvelope` is a discriminated union over `event`, so narrowing on it
types `data` for you. Deliveries older than 300 s are rejected; widen with
`toleranceSeconds`.

Note that `X-Webhook-Delivery` is currently regenerated per delivery attempt
server-side, so it cannot be used to deduplicate a redelivery. Key on the
payload's own identifiers (`transaction_id`, `audit_id`) instead.

## Enums

`Decision`, `DecisionSource`, `TransactionType`, `CustomerType`, `RuleStage`,
`ReasonBasis`, and `WebhookEvent` are exported as string enums. Request and
response fields accept plain strings too, so importing them is optional.

## Development

```bash
npm install
npm run lint     # eslint + tsc --noEmit
npm test         # jest
npm run build    # dual ESM + CJS build into dist/
```

Response types are hand-copied from the server.
`test/contracts/sdk-types.contract.test.ts` in the repo root compares them
field by field against the server declarations and fails the **server's** CI on
drift in either direction.

Tests stub `fetch`, so they cover this client's behaviour and not the server's.
The request and response shapes are verified against server source by the
contract test above, not against live responses.
