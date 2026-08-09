# Troubleshooting

Symptoms you're most likely to hit on a fresh install, and what they mean.
Most are expected behaviour rather than faults — each entry says which.

## Install and startup

**`Cannot connect to the Docker daemon`**
Docker isn't running. Start Docker Desktop (macOS/Windows) or
`sudo systemctl start docker` (Linux), then confirm with `docker info`.

**`unknown directive !reset` (or the GHCR overlay is ignored)**
Docker Compose is older than 2.24. Check with `docker compose version`.
Either upgrade Compose or use the build-from-source path, which needs no
overlay.

**RDA refuses `/v1/auth/login`, or admin endpoints return 500**
`.env` is missing. `cp .env.example .env` before the first
`docker compose up` — it supplies `AUTH_JWT_SECRET` (required for login)
and the `DB_*` block the Knex-backed admin endpoints need. Rotate
`AUTH_JWT_SECRET` before any non-dev deploy.

**A container fails to bind a port**
Ojuri needs these host ports free: `80 3000 3001 5173 5433 6380 9090 9091
9093 9094 29092`. Postgres in Docker listens on `5433`, not `5432`, to
avoid conflicting with a host Postgres.

**Lost the seeded admin password**
It's printed once, by `docker compose logs db-migrate`. `npm run
reset:admin` mints a fresh random one; `npm run reset:admin -- --password
'my-chosen-secret'` sets a specific one. Either way the new password
carries `mustChangePassword=true`.

## Dashboard

**Login returns 502**
The frontend `.env` is pointing at a host-side RDA on `:3000` while the
backend is running in Docker behind NGINX. Uncomment the "Docker stack"
block in `frontend/.env`. See [`FRONTEND.md`](FRONTEND.md).

**`crypto.getRandomValues is not a function` on `npm run dev`**
Node is older than 18. The repo pins 20 in `.nvmrc` — run `nvm use` from
the repo root.

**The dashboard opens on a port other than 5173**
Another Vite project holds 5173, so Vite serves on the next free port. Use
the URL Vite prints rather than a bookmark.

**Every page is empty and an OFFLINE banner is showing**
Reads in the Sentinel client fall back to empty values when the backend is
unreachable or returns 401 — there is no synthetic data. Check that RDA is
up, and that `sentinel.jwt` is set in `localStorage` (it is, after a
successful login).

## Predictions

**A bare request returns `DECLINE`**
Expected. With no context fields and a cold feature cache, the demo model
scores the default feature vector as risky. Send the context fields shown
in the Quick start, or send more traffic so PAA warms the Redis cache.

**`"decision_source": "PRE_RULE"` when you expected the model to score**
A seeded rule fired before the model ran — one of the FATF pack, or a demo
rule if you enabled them with `SEED_DEMO_RULES_ACTIVE=true`. Rules are
visible and editable in Sentinel → Rules. See [`RULES.md`](RULES.md).

**`"model_version": "default"`**
Expected on a fresh install. The demo ONNX model scores every prediction,
but no version is registered in the model registry yet, so the label falls
back to `default`. It becomes `v1.x` once you register a trained model.
See [`MODEL-REGISTRY.md`](MODEL-REGISTRY.md).

**`"decision_source": "BREAKER_FALLBACK"`**
ONNX inference didn't run — the circuit breaker tripped, usually on a
per-call timeout under contention. The decision comes from
`CB_ONNX_FALLBACK_DECISION` (default `REVIEW`), not from a model score.
Sustained occurrences mean `CB_ONNX_TIMEOUT` (default 750 ms) is below
your actual p95 under load.

**`/readyz` reports `{"name":"onnx-model","status":"DOWN"}`**
The model failed its load-time calibration probe — file missing, constant
output, or a feature-dimension mismatch against
`models/feature-catalog.v1.json`. Note that the predict route is *not*
gated on this: `isReady()` feeds the health check only. Take the instance
out of rotation on the `/readyz` signal. If the ONNX session is genuinely
unusable, inference throws and the breaker fallback returns
`{ score: 1.0, degraded: true }`, which `PredictService` maps to
`CB_ONNX_FALLBACK_DECISION` (default `REVIEW`) — not an automatic
DECLINE.

## Training and models

**MLA logs `⚠️  No production model found in registry`**
Expected on a fresh checkout, and not a conflict with the shipped demo
model. `models/fraud_model.onnx` is what RDA loads so predictions work;
MLA's registry scans `models/versions/<v>/` for lineage-tracked versions,
and that directory ships empty. Seed it with `python
scripts/train_initial_model.py`.

**Training falls back to synthetic data**
The `transactions` table has no non-null `fraudLabel` values. Fine for a
dev walkthrough, not for production results — load real labelled data
first. See [`TRAINING.md`](TRAINING.md) and
[`ADOPTER_TRAINING.md`](ADOPTER_TRAINING.md).

**`TypeError: Field onnx.AttributeProto.ints: Expected an int, got a
boolean`**
The ONNX toolchain drifted off its pins. Reinstall the exact versions in
`mla-service/requirements.txt` (`onnx==1.13.0`, `onnxmltools==1.10.0`,
`onnxconverter-common==1.12.0`). Don't bump them without testing the full
training → ONNX → RDA inference path.

**Sentinel's System health page shows MLA offline**
Expected unless you started MLA. It's opt-in — either `--profile mla` on a
compose command (with `MLA_HEALTH_URL=http://mla:9095` in `.env`) or a
host venv.

## FIA

**The first investigation appears to hang for several minutes**
On Apple Silicon the first generation triggers a one-time 6–10 minute MPS
kernel compilation. Expect ~45 s model load, then 40–90 s per report
steady-state. The first run also downloads ~7.6 GB of Phi-3-mini weights
to `~/.cache/huggingface`.

**Reports look rule-shaped rather than LLM-written**
The LLM couldn't load and `FIA_FALLBACK_ON_LLM_FAILURE` (default `true`)
degraded to a deterministic rule-based report so the pipeline still
produces parseable rows. Check FIA's logs for the load failure, and that
you have ≥16 GB free RAM.

## Benchmarking

Two shipped defaults produce confidently-wrong fast numbers. Both are in
[`ARCHITECTURE.md`](ARCHITECTURE.md#8-performance-characteristics) in full:

- **NGINX rate limit.** `/v1/predict` is capped at 100 r/s with a burst of
  50 per source IP. From one benchmark host, anything above ~150 RPS is
  rejected with HTTP 503 without reaching RDA — you end up measuring
  NGINX's reject latency.
- **Idempotency duplicate short-circuit.** Reusing one `transaction_id`
  across requests returns 409 without running the model, which is far
  faster than the real predict path.

Measure with a unique `transaction_id` per request, and assert every
response is HTTP 200 before computing percentiles.

---

Still stuck? Open an issue at
[github.com/ojuri-io/ojuri/issues](https://github.com/ojuri-io/ojuri/issues).
Security-sensitive reports go through [`SECURITY.md`](../SECURITY.md)
instead.
