# @ojuri/sdk

Typed Node client for the [Ojuri](https://github.com/ojuri-io/ojuri) fraud-detection
platform: `POST /v1/predict`, the decision/audit reads behind the Sentinel
dashboard, FIA investigation reports, and webhook signature verification.

Zero runtime dependencies. Ships ESM and CommonJS. Node 18+.

```bash
npm install @ojuri/sdk
```

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
});

if (decision.decision === "DECLINE") {
  block(decision.reason_codes);
}
```

Those six fields are the only required ones. Every optional field in
[`docs/PREDICT-API.md`](../../docs/PREDICT-API.md) — identity, device,
geography, channel — only sharpens the score; the feature catalogue
substitutes defaults for anything you omit.

## Configuration

```ts
new OjuriClient({
  baseUrl: "https://rda.example.com",  // required
  fiaUrl: "https://fia.example.com",   // required only for `reports`
  apiKey: "fdk_<prefix>_<secret>",     // X-Api-Key, for /v1/predict
  jwt: "eyJ...",                       // Bearer, for audit reads and reports
  tenantId: "acme",                    // X-Tenant-ID
  timeoutMs: 10_000,
  maxRetries: 2,
  retryBaseDelayMs: 200,
  autoIdempotencyKey: true,
  fetch: customFetch,                  // defaults to global fetch
});
```

`predict` uses the API key; everything else needs a user JWT. Get one with
`login()` — the client stores it for subsequent calls:

```ts
await ojuri.login({ username: "admin", password: process.env.OJURI_PASSWORD! });
const queue = await ojuri.decisions.reviewQueue({ limit: 25 });
```

## Idempotency and retries

Every `predict()` call attaches a generated `Idempotency-Key`, held stable
across retries so a retried call replays the original decision instead of
landing as a fresh transaction. Pass your own with
`predict(request, { idempotencyKey })`, or turn generation off with
`autoIdempotencyKey: false`.

Retries cover `408`, `429`, `502`, `503`, `504`, network failures, timeouts,
and any response carrying `Retry-After` (which is how RDA marks an
Idempotency-Key still in flight). Backoff is exponential with full jitter,
capped at 20 s; a `Retry-After` value wins over the computed delay.

`500` is deliberately not retried — the server handled the request and failed
inside it, so a blind retry can duplicate effects the client cannot see.

## Errors

Every failure is an `OjuriError` subclass:

| Class | Raised when |
|---|---|
| `OjuriApiError` | Non-2xx response. Carries `status`, `errors[]`, `correlationId`, `retryAfterSeconds`, `body`. |
| `OjuriTimeoutError` | The per-request timeout elapsed. |
| `OjuriNetworkError` | The request never reached the server. |
| `OjuriValidationError` | Client-side input rejected before sending. |
| `OjuriConfigurationError` | Missing credential or `fiaUrl`. |

```ts
import { OjuriApiError } from "@ojuri/sdk";

try {
  await ojuri.predict(request);
} catch (err) {
  if (err instanceof OjuriApiError && err.status === 409) {
    // transaction_id already processed for this tenant
  }
  throw err;
}
```

## Decisions and review queue

```ts
await ojuri.decisions.get("txn-1");
await ojuri.decisions.recent({ since: new Date(Date.now() - 3_600_000), limit: 50 });
await ojuri.decisions.similar(auditId, { limit: 5 });
await ojuri.decisions.reviewQueue({ limit: 25, order: "oldest", search: "acct-123" });
await ojuri.decisions.override(auditId, { decision: "ACCEPT", reason: "verified by phone" });
```

## Investigation reports (FIA)

Requires `fiaUrl`. Report generation runs an LLM, so these calls default to a
180 s timeout rather than the client's normal one.

```ts
const { report, created } = await ojuri.reports.create({ transaction_id: "txn-1" });
const answer = await ojuri.reports.message(report.report_id, "What would change the verdict?");
await ojuri.reports.list({ status: "GENERATED", limit: 50 });
```

`created` is `false` when an existing report was returned — the endpoint is
idempotent by `transaction_id`.

## Webhook verification

Verify against the **raw** request body. A re-serialised object will not match.

```ts
import { verifyWebhookSignature } from "@ojuri/sdk";

app.post("/hooks/ojuri", express.raw({ type: "application/json" }), (req, res) => {
  const ok = verifyWebhookSignature({
    secret: process.env.OJURI_WEBHOOK_SECRET!,
    signatureHeader: req.header("X-Webhook-Signature"),
    rawBody: req.body,
  });
  if (!ok) return res.sendStatus(401);
  res.sendStatus(204);
});
```

Deliveries older than 300 s are rejected; widen with `toleranceSeconds`.

## Enums

`Decision`, `DecisionSource`, `TransactionType`, `CustomerType`, `RuleStage`,
`ReportStatus`, `ReviewOrder`, and `WebhookEvent` are exported as string enums.
Request and response fields accept plain strings too, so importing them is
optional.

## Development

```bash
npm install
npm run lint     # tsc --noEmit
npm test         # jest
npm run build    # dual ESM + CJS build into dist/
```
