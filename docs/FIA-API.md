# FIA HTTP API

FIA (Fraud Investigation Agent) generates analyst-readable
investigation reports using a fine-tuned Phi-3 LLM. Originally
consumer-only (subscribed to `transactions.blocked` Kafka topic), it
now also exposes an HTTP API so a case-management UI can request
reports on demand and support multi-turn follow-ups.

The HTTP API runs on the same port as the health endpoints
(`METRICS_PORT`, default `9094`).

## Starting FIA

FIA is gated behind the `fia` Compose profile so first-run adopters
aren't forced to download ~7.6 GB of Phi-3 weights before they can
see anything work. Once the rest of the stack is up:

```bash
docker compose --profile fia up --build -d fia
docker compose logs -f fia
```

The first boot downloads Phi-3-mini into the named `fia-hf-cache`
volume; subsequent restarts reuse it. On a host without GPU/MPS and
without spare RAM, set `FIA_FALLBACK_ON_LLM_FAILURE=true` (the
default) — FIA will boot in degraded mode and serve deterministic
rule-based reports instead of failing.

## Providing the model weights

**The `fia` image does not contain the model.** It ships the Python
runtime — torch, transformers, the FIA code — at roughly 1.2 GB. The
~7.6 GB of Phi-3-mini weights are fetched separately at first start.

That matters if your deployment restricts outbound traffic. Ojuri keeps
*transaction* data on your infrastructure, but a default FIA start
reaches out to `huggingface.co` once to obtain the model. Three ways to
handle it:

**1. Let it download (default).** `HF_HOME=/app/.hf-cache` is baked
into the image, and Compose mounts the named `fia-hf-cache` volume
there, so the download survives container recreates. Budget ~10 GB of
disk and the bandwidth for a one-time 7.6 GB pull.

**2. Pre-stage the weights — no egress at runtime.** Put a local
checkpoint under `fia-service/models/` (already mounted to
`/app/models`) and point FIA at it:

```bash
# in .env
FIA_LLM_MODEL_PATH=/app/models/phi-3-mini-4k-instruct
```

`LLM_MODEL_PATH` takes precedence over `LLM_MODEL_NAME`, so nothing is
resolved from the Hub. This is also the hook for a fine-tuned
checkpoint of your own.

**3. Skip the LLM entirely.** `FIA_DISABLE_LLM=true` short-circuits the
import and load before transformers is touched — no download, no ~15 GB
resident model. Every report comes from the deterministic rule-based
generator, and the pipeline still produces parseable rows. Intended for
demos, CI, and hosts capped under 16 GB.

Note this is *not* the same switch as `FIA_FALLBACK_ON_LLM_FAILURE`,
which only engages **after** a load has been attempted and failed. If
your goal is "never load the model", use `FIA_DISABLE_LLM`; the
fallback flag won't save you from the memory spike.

> **Variable naming.** In `.env` you set `FIA_LLM_MODEL_PATH` and
> `FIA_LLM_MODEL_NAME`; Compose maps those to `LLM_MODEL_PATH` and
> `LLM_MODEL_NAME` inside the container. `FIA_DISABLE_LLM` and
> `FIA_FALLBACK_ON_LLM_FAILURE` keep the same name on both sides.
> Running FIA outside Compose means using the unprefixed
> `LLM_*` names.

For safety, `trust_remote_code` is only honoured for an allowlist of
known Phi-3 repositories — pointing `LLM_MODEL_NAME` at an arbitrary
Hub repo will not silently execute its `modeling_*.py`.

## Endpoints

| Method | Path                                  | Purpose                                  | Auth                  |
|--------|---------------------------------------|------------------------------------------|-----------------------|
| GET    | `/livez`                              | Liveness                                 | open                  |
| GET    | `/readyz`                             | Kafka consumer connected                 | open                  |
| GET    | `/stats`                              | Lifetime counters + LLM model version    | `metrics:read`        |
| GET    | `/v1/reports`                         | List recent reports (paginated)          | `reports:read`        |
| GET    | `/v1/reports/{report_id}`             | Read a report + conversation history     | `reports:read`        |
| POST   | `/v1/reports`                         | Generate a report for any transaction    | `reports:request`     |
| POST   | `/v1/reports/{report_id}/messages`    | Ask a follow-up question                 | `reports:message`     |

All payloads are JSON.

## Authentication

Every route except `/livez` and `/readyz` requires an `Authorization:
Bearer <jwt>` header. FIA shares `AUTH_JWT_SECRET` with RDA, so the
JWT issued by `POST /v1/auth/login` against RDA is accepted directly —
no separate FIA login. The token's `permissions[]` claim must include
the permission listed in the table above (the wildcard `*` granted to
`SUPER_ADMIN` satisfies all of them).

FIA verifies HS256 signatures using stdlib `hmac` to avoid bloating the
container image with an extra dependency. Other algorithms (`alg: none`,
`RS*`, `HS384/512`) are rejected.

The HTTP server binds to `127.0.0.1` by default (see `FIA_HTTP_BIND`).
Compose flips this to `0.0.0.0` because the container's loopback is
isolated from the host anyway, but bare-metal deployments should keep
the loopback default and proxy through RDA or an authenticating front
door.

## Generating a report on demand

`POST /v1/reports` is idempotent by `transaction_id`. If a report
already exists for that transaction, the existing row is returned
with status 200; otherwise a new report is generated and persisted
with status 201.

```bash
curl -X POST http://localhost:9094/v1/reports \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
    "sender_id": "user_acme_42",
    "receiver_id": "user_acme_99",
    "amount": 250000,
    "transaction_type": "TRANSFER",
    "fraud_probability": 0.91,
    "decision": "DECLINE",
    "device_fingerprint": { "os": "android", "browser": "chrome" },
    "timestamp": 1715000000
  }'
```

Required: `transaction_id`, `sender_id`, `amount`, `transaction_type`.
The rest is optional — `decision` defaults to `"DECLINE"` and
`fraud_probability` to `0.0`. The endpoint deliberately accepts
non-blocked transactions so reviewers can ask FIA for context on a
transaction that was *almost* declined.

Response (truncated):

```json
{
  "id": "f3d7c0bc-…",
  "transactionId": "550e8400-…",
  "verdict": "FRAUD_CONFIRMED",
  "recommendedAction": "BLOCK",
  "agentConfidence": 0.88,
  "narrative": "The sender's 24-hour velocity is 4× their 30-day baseline, the receiver matches a known mule pattern, …",
  "keyIndicators": ["Velocity spike", "Mule-network receiver", "Off-hour transfer"],
  "conversation": []
}
```

## Conversational follow-ups

A FIA report is one-shot by default — verdict + narrative + key
indicators. Reviewers often want to drill in: *"Why is the recommended
action BLOCK and not CONTACT_CUSTOMER?"*, *"How confident is the
'mule-network receiver' indicator?"*, *"What would change your
verdict?"*. That's what the messages endpoint is for.

```bash
curl -X POST http://localhost:9094/v1/reports/f3d7c0bc-…/messages \
  -H "Content-Type: application/json" \
  -d '{ "content": "What would change the verdict from FRAUD_CONFIRMED to UNCERTAIN?" }'
```

Response:

```json
{
  "report_id": "f3d7c0bc-…",
  "user_turn":      { "role": "user",      "content": "What would change …" },
  "assistant_turn": { "role": "assistant", "content": "If the receiver has prior accepted transfers from this sender …",
                      "llm_model_version": "microsoft/Phi-3-mini-4k-instruct",
                      "latency_ms": 5210 }
}
```

Turns are persisted in `investigationConversations` with a stable
`turnIndex`. Subsequent calls to `GET /v1/reports/{id}` return the
full conversation in order.

## Latency expectations

LLM generation is the dominant cost.

| Hardware                          | First-token | Full report (~300 tok) | Steady state |
|-----------------------------------|-------------|------------------------|--------------|
| NVIDIA A10 / L4, fp16             | ~1 s        | ~6 s                   | ~6–10 s      |
| Apple Silicon, MPS, fp16          | ~6 min once *                  | ~40–90 s     | ~40–90 s     |
| CPU only, fp32                    | n/a         | minutes                | minutes      |

\* First MPS run compiles kernels; subsequent generations are fast.

This is why FIA is async by design — it must **never** be called on the
`/v1/predict` authorization path.

## Degradation: LLM unavailable

When `transformers` / `torch` are missing, the model weights can't
load, or generation fails, `FIA_FALLBACK_ON_LLM_FAILURE=true` (the
default) makes FIA fall back to a **deterministic rule-based** report
and a **templated chat answer**. The pipeline still produces parseable
rows and the UI still has something to render — it just won't be as
nuanced.

The fallback is visible in two places:

- `model_version` ends in `-fallback`.
- The narrative starts with `Automated fallback report (LLM unavailable).`

Adopters who'd rather fail loud should set
`FIA_FALLBACK_ON_LLM_FAILURE=false` — generation errors then propagate
as 500s.

## Listing reports

```bash
curl "http://localhost:9094/v1/reports?status=GENERATED&limit=50&offset=0"
```

Filters: `status` (`GENERATED` / `REVIEWED` / etc., matches the
`investigationReports.status` column).

## Concurrency

FIA's HTTP server is `socketserver.TCPServer` with the standard
Python threading model — every request gets its own thread, but
generations serialize through the single PyTorch model. Practically:
**don't expect to run 10 chat sessions concurrently** unless you've
provisioned multiple FIA replicas behind a load balancer. The
report-write idempotency keys by `transactionId`, so distributing
across replicas is safe.

## Wire-level details

- Content-Type: `application/json` on every response.
- `report_id` must be a UUID — invalid IDs return 400.
- Pagination caps at `limit=200`.
- The HTTP API does **not** currently require an API key. Restrict
  network access to FIA (private subnet, ingress controller) until
  shared auth ships.
