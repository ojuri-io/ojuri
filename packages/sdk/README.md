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

Only reads and idempotent writes are retried. `predict` qualifies while it
carries an Idempotency-Key; `login`, `decisions.override`, and
`reports.message` are never replayed, because a duplicate override fires a
second webhook and a second ground-truth label, and a duplicate message
appends another LLM turn. `reports.create` is retried — the server's
`ON CONFLICT ("transactionId") DO NOTHING` makes a replay return the existing
report.

Retryable failures are `408`, `429`, `502`, `503`, `504`, network failures,
timeouts, and any 4xx carrying `Retry-After` (which is how RDA marks an
Idempotency-Key still in flight). Both `Retry-After` forms are read — delay-seconds and
HTTP-date — and a negative or past value clamps to zero. Backoff is otherwise
exponential with full jitter, capped at 20 s.

`500` is never retried, even with a `Retry-After` header: the server handled
the request and failed inside it, so a blind retry can duplicate effects the
client cannot see.

`deadlineMs` caps total wall-clock time per call including every retry and
backoff, defaulting to `timeoutMs * (maxRetries + 1)`. Without it a client
reading as "10 seconds" can block far longer once backoff is counted.

Pass an `AbortSignal` to cancel. A signal that is already aborted stops the
call before it is sent, and aborting during a backoff wait ends the retry loop
immediately rather than waiting it out. Cancellation surfaces as the runtime's
own `AbortError`, not an `OjuriError`.

## Errors

Every failure the SDK raises is an `OjuriError` subclass. Cancellation is the
one exception — an aborted call rejects with the runtime's own `AbortError`,
as `fetch` does:

| Class | Raised when |
|---|---|
| `OjuriApiError` | Non-2xx response. Carries `status`, `errors[]`, `correlationId`, `retryAfterSeconds`, `body`. |
| `OjuriTimeoutError` | The per-request timeout elapsed. |
| `OjuriNetworkError` | The request never reached the server. |
| `OjuriValidationError` | Client-side input rejected before sending — a `transaction_id` outside 10-255 characters, an over-long `idempotencyKey`, or an empty/dot-only path id. |
| `OjuriResponseError` | The server answered with something unusable — a non-JSON 200, a decision with no `decision`, a login with no token. |
| `OjuriConfigurationError` | Missing credential, or a `baseUrl`/`fiaUrl` that is not an absolute http(s) URL. |

Use the static predicates rather than `instanceof`. Publishing both ESM and
CJS means an app can load two copies of this package, and `instanceof` fails
across them:

```ts
import { OjuriApiError } from "@ojuri/sdk";

try {
  await ojuri.predict(request);
} catch (err) {
  if (OjuriApiError.isOjuriApiError(err) && err.status === 409) {
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

`ojuri.reports` is present only when `fiaUrl` is configured, so it is typed
optional. Report generation runs an LLM, so these calls default to a 180 s
timeout unless you set `timeoutMs` explicitly.

Persisted report rows come back camelCase (FIA selects quoted column names),
while the request bodies it accepts are snake_case. `list()` returns the
narrower `InvestigationReportSummary` — it does not select `narrative` or
`keyIndicators`.

```ts
const { report, created } = await ojuri.reports!.create({ transaction_id: "txn-1" });
const answer = await ojuri.reports!.message(report.id, "What would change the verdict?");
await ojuri.reports!.list({ status: "GENERATED", limit: 50 });
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

## Credentials

The API key and JWT are held in private class fields and omitted from
`JSON.stringify`, `console.log`, and `util.inspect`, so a client caught by a
logger or crash reporter does not put them in cleartext.

## Enums

`Decision`, `DecisionSource`, `TransactionType`, `CustomerType`, `RuleStage`,
`RuleAction`, `ReasonBasis`, `ReportStatus`, `ReviewOrder`, and `WebhookEvent`
are exported as string enums.
Request and response fields accept plain strings too, so importing them is
optional.

## Development

```bash
npm install
npm run lint     # tsc --noEmit
npm test         # jest
npm run build    # dual ESM + CJS build into dist/
```

Response types are hand-copied from the server. `test/contracts/sdk-types.contract.test.ts`
in the repo root compares them field by field and fails the **server's** CI on
drift in either direction.
