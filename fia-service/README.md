# Fraud Investigation Agent (FIA)

Python service that consumes blocked transactions from Kafka and produces
human-readable investigation reports via a fine-tuned Phi-3-mini-4k-instruct
model. Reports are written to PostgreSQL `investigationReports` and surfaced
to analysts. **FIA never touches the real-time authorization path.**

## Pipeline

```
RDA (decision = DECLINE)
   │ fire-and-forget Kafka publish
   ▼
transactions.blocked   ─►   FIA consumer
                              │
                              ▼  Phi-3 prompt
                            LLM ────► JSON report
                              │
                              ▼
                     investigationReports (Postgres)
```

## Setup

### Full setup (real LLM)

```bash
cd fia-service
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt        # ~3 GB: torch + transformers + accelerate
cp .env.example .env
PYTHONPATH=. python -m src.main
```

The **first run downloads ≈7.6 GB of Phi-3-mini-4k-instruct weights** to
`~/.cache/huggingface` (or `$HF_HOME` if set). Expect 5–15 minutes on a
typical home connection. Subsequent boots load from cache in seconds.

### Device selection

`LLM_DEVICE=auto` resolves in this order:

1. `cuda` if `torch.cuda.is_available()`.
2. `mps` on Apple Silicon (Metal Performance Shaders).
3. `cpu` otherwise — works but ≥30 s per report; not recommended for live use.

On non-CUDA backends FIA forces `attn_implementation="eager"` because Phi-3's
default flash-attention kernels only run on CUDA. dtype defaults to `float16`
on CUDA/MPS and `float32` on CPU.

### Lightweight setup (rule-based fallback only)

For wiring tests, CI, or laptops without spare disk, skip the heavy stack:

```bash
pip install kafka-python==2.0.2 sqlalchemy==2.0.25 psycopg2-binary==2.9.9 \
            pydantic==2.6.4 python-dotenv==1.0.1
FIA_FALLBACK_ON_LLM_FAILURE=true PYTHONPATH=. python -m src.main
```

`FIA_FALLBACK_ON_LLM_FAILURE=true` (the default) makes FIA degrade to a
deterministic rule-based report when `torch` is missing, the model fails to
load, or generated JSON fails schema validation — the pipeline still produces
parseable rows.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka cluster |
| `KAFKA_BLOCKED_TOPIC` | `transactions.blocked` | Topic RDA publishes DECLINEs to |
| `KAFKA_CONSUMER_GROUP` | `fraud-investigation` | Distinct from `pattern-analysis` |
| `POSTGRES_*` | see `.env.example` | Same `fraud_db` shared with RDA/PAA/MLA |
| `LLM_MODEL_NAME` | `microsoft/Phi-3-mini-4k-instruct` | HF model id |
| `LLM_MODEL_PATH` | _(unset)_ | Local fine-tuned checkpoint dir; overrides `LLM_MODEL_NAME` |
| `LLM_DEVICE` | `auto` | `auto`, `cpu`, `cuda`, `cuda:0`, `mps` |
| `LLM_DTYPE` | `auto` | `float16`, `bfloat16`, `float32` |
| `LLM_MAX_NEW_TOKENS` | `384` | Cap on report length |
| `LLM_TEMPERATURE` | `0.2` | Lower = more deterministic |
| `FIA_FALLBACK_ON_LLM_FAILURE` | `true` | Degrade to rule-based on LLM error |
| `METRICS_PORT` | `9094` | `/livez`, `/readyz`, `/stats` |

## Idempotency

`investigationReports.transactionId` is `UNIQUE`. The writer uses
`INSERT ... ON CONFLICT DO NOTHING`, so re-delivered Kafka messages do not
crash the consumer and do not produce duplicate reports.

## Health endpoints

- `GET /livez` → `{"status": "UP"}`
- `GET /readyz` → 200 if Kafka is connected, 503 otherwise
- `GET /stats` → counters + active LLM model id

## Schema (LLM JSON contract)

```json
{
  "verdict": "FRAUD_CONFIRMED | LIKELY_LEGITIMATE | UNCERTAIN",
  "agent_confidence": 0.0,
  "recommended_action": "BLOCK | CONTACT_CUSTOMER | MANUAL_REVIEW | RELEASE",
  "key_indicators": ["short string", "..."],
  "narrative": "3-5 sentence analyst-readable summary"
}
```

Pydantic enforces this contract; bad output triggers fallback or retry.
