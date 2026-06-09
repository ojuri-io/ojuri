# Internals — How Ojuri actually works

This document is the in-depth study guide for the platform.
[`ARCHITECTURE.md`](ARCHITECTURE.md) tells you what the boxes are
and which arrows point at them; this file tells you what is
*happening inside each box*. Read it once and you will be able to
hold any technical conversation about how the system makes a
decision, why it makes that decision, and what its real
limitations are.

It is written for someone who knows software engineering well but
may not have a fraud-domain or ML background. Every formula has a
plain-English version next to it.

## Contents

1. [Fraud detection 101](#1-fraud-detection-101)
2. [The decision pipeline](#2-the-decision-pipeline)
3. [The features](#3-the-features)
4. [The model](#4-the-model)
5. [The graph](#5-the-graph)
6. [Training](#6-training)
7. [Drift detection](#7-drift-detection)
8. [Investigation (FIA / LLM)](#8-investigation-fia--llm)
9. [Rules engine](#9-rules-engine)
10. [Operational mechanics](#10-operational-mechanics)
11. [Adversarial considerations](#11-adversarial-considerations)
12. [Glossary](#12-glossary)

---

## 1. Fraud detection 101

### The problem shape

Fraud detection is a binary classification problem with two
features that bend every engineering decision around them:

- **Severe class imbalance.** In a healthy book of business, ~0.1–
  2% of transactions are fraudulent. A model that predicts "not
  fraud" for everything achieves 98–99.9% accuracy and is useless.
  Standard ML metrics like accuracy are misleading; you reach for
  **precision**, **recall**, **F1**, **AUC-ROC**, and **PR curves**
  (see Glossary).
- **Asymmetric error costs.** A false positive blocks a real
  customer's transaction (lost revenue + frustrated user). A false
  negative lets fraud through (direct money loss + chargeback
  fees + regulatory exposure). These costs are not equal and they
  are not equal for every transaction — declining a £5 payment is
  cheap; declining a £50,000 wire is not.

This shape forces every design decision: how you sample data, how
you train, how you set the decision threshold, how you measure
success.

### The labelling problem

Most ML problems have ground-truth labels. Fraud detection
*doesn't*, and this is the single most consequential thing to
internalise.

When the platform decides `ACCEPT`, the transaction goes through.
You learn it was fraud only if the customer disputes it later
(chargeback), the receiver gets flagged downstream, or a
regulatory body queries it. Most fraud you accept you never
discover.

When the platform decides `DECLINE`, you blocked the transaction.
You learn it was fraud only if a reviewer overrides your decision
in the dashboard ("released — actually legitimate") or a customer
calls in. Otherwise the label is your own decision.

**This is why the platform deliberately writes `fraudLabel = NULL`
on every new row** (`paa-service/src/services/postgres.service.ts:55-63`).
If you persisted your own DECLINE as a label, the next training
run would learn to reproduce your past decisions — a self-confirming
loop where the model never discovers that some of your blocks were
mistakes.

The actual training signal comes from **`groundTruthFraud`** —
populated only when a human reviewer overrides a decision, or a
chargeback writer (not shipped yet) attaches a verified label.
MLA's training query is
`COALESCE(groundTruthFraud, fraudLabel)` (`mla-service/src/training/data_loader.py:140`)
with the COALESCE there for backward compatibility with pre-2026-05
rows that had `fraudLabel` set; for adopters on v1.0+ every new row
has `fraudLabel = NULL` and only ground-truth flows in.

### Common fraud patterns

The vocabulary you'll hit in adopter conversations:

- **CNP (Card-Not-Present)** — fraud on a payment where the card
  was used without physical presence (online, phone). The dominant
  vector for e-commerce.
- **ATO (Account Takeover)** — attacker gains control of a
  legitimate user's account (credential stuffing, phishing) and
  transacts as them. Detection signal: behaviour deviation from
  the account's history — new device, new geography, new
  counterparty, new amount distribution.
- **Synthetic identity** — combination of real and fabricated PII
  used to open new accounts that build a clean credit history,
  then "bust out." Detection signal: thin or impossible-looking
  identity context (`account_age_days` low + first large
  transaction + no prior counterparty).
- **Bust-out** — a maturation strategy where synthetic or stolen
  identities behave normally for weeks/months to build
  trustworthiness, then coordinate a simultaneous cash-out.
  Detection signal: graph-cluster behaviour (Louvain community
  flips active suddenly).
- **Money mule** — a (often unwitting) third party whose account
  is used as a hop in laundering. Detection signal: high in-degree
  in the transaction graph with disposable outflow patterns.
- **Ring** — a collusive group of accounts laundering money
  through closed loops or fan-out/fan-in patterns. See [§5](#5-the-graph).
- **Structuring** — splitting one large transaction into many
  smaller ones to stay under a reporting threshold (e.g., FATF's
  $10,000 USD cash-reporting line). Detection signal: a sequence
  of just-under-threshold amounts from the same sender in a short
  window.
- **Friendly fraud** — a legitimate customer disputes a charge
  they genuinely made. Different from "true fraud"; the model
  can't really catch it from features alone.

### Regulatory context

- **AML (Anti-Money Laundering)** — the regulatory regime under
  which fraud platforms operate. Imposes reporting obligations
  (SARs), customer due diligence (KYC), and screening against
  sanctions lists.
- **KYC (Know Your Customer)** — identity-verification step at
  account opening. Ojuri doesn't do KYC; it consumes KYC outputs
  (`account_age_days`, `is_authenticated`, `customer_id_type`) as
  features.
- **FATF (Financial Action Task Force)** — the international
  AML standard-setter. The default rule pack in
  `src/database/seeds/03_fatf_rule_pack.ts` implements five
  FATF-aligned rules (structuring, VPN-plus-amount, high-risk
  corridor TRANSFER, ATO signature, untrusted device + amount).
- **SAR (Suspicious Activity Report)** — the regulatory filing a
  financial institution makes when it detects suspicious activity.
  Different jurisdictions have different thresholds; the rule pack
  ships NGN-tuned defaults that adopters re-tune per market.

---

## 2. The decision pipeline

What actually happens when `POST /v1/predict` lands. The whole
path is in `src/v1/modules/rda/services/predict.service.ts` and is
deliberately split into named stages — read that file alongside
this section.

### Stage 0: Request admission

- **Auth** — API-key middleware checks `X-Api-Key` against the
  SHA-256-hashed key store, with a 30-second verification cache
  (`src/shared/auth/api-key.service.ts`). If `RDA_REQUIRE_API_KEY=false`
  the predict endpoint is open; flipping it to `true` is the
  production posture.
- **Validation** — request body validated against
  `predict.validator.ts`. ~40 optional context fields are accepted
  (device, geography, identity); missing fields fall back to
  catalogue defaults.
- **Idempotency** — if the caller sent `Idempotency-Key`, RDA hashes
  the body and looks for a previous response keyed by
  `(tenantId, key, requestHash)`. Cache hit returns the cached
  response with `Idempotency-Replay: true`; cache hit with body
  divergence returns 422. See [`IDEMPOTENCY.md`](IDEMPOTENCY.md).

### Stage 1: Resolve the model

`ModelRegistryService.resolve(segment)` returns
`{champion, shadow, threshold}`. The lookup uses
`request.segment ?? request.transaction_type` so an adopter can
either pass an explicit segment label or let transaction-type
drive routing. Champion model = the one whose score becomes the
decision. Shadow model = a candidate also scored on the same
features for offline comparison (its score is written to the
audit log but not acted upon).

### Stage 2: Load features

`buildFeatures()` (`src/shared/features/feature-builder.ts`)
walks the 64-feature catalogue and resolves each one through its
`compute` op (`from_field`, `from_redis`, `equals`, `is_one_of`,
`ratio`, `lookup`, `numeric_bucket`, `bool_and`, `bool_or`,
`custom`). Sources:

- **Request body** — transaction-level features the caller sent
  directly (`amount`, `transaction_type`, `is_authenticated`, ...).
- **Redis** — PAA-computed aggregate features for the sender,
  keyed `features:{senderId}`. Velocity counters, graph centrality,
  community membership. Cache miss → catalogue defaults (logged as
  a degraded-accuracy warning, not a failure).
- **Custom resolvers** — adopter-defined feature functions
  registered at boot.

Output: a 64-element float array, ordered by catalogue index, that
matches the input dimension the model was trained against. If the
model's `feature_schema_version` doesn't match the catalogue's,
the model refuses to load — this is the defence against the
classic offline/online feature-skew bug.

### Stage 3: Evaluate PRE-stage rules

The rules engine (`src/shared/rules/`) evaluates JSON-Logic
predicates. PRE rules short-circuit the model — if any PRE rule
matches, the decision is the rule's action and ML never runs. This
is where mandatory blocks live (sanctions, structuring, known-fraud
patterns).

### Stage 4: ONNX inference

`OnnxService.predict(featureVector)` runs the deployed XGBoost
model. p99 is ~49 µs at batch=1 on a developer workstation. The
output is a calibrated fraud probability `p ∈ [0, 1]`.

The session uses a pool (default 4 sessions, `intraOpNumThreads=2`)
so concurrent requests don't queue on a single inference handle.
A two-check calibration probe runs at model load (deterministic
re-run + clearly-legit vs clearly-fraud discrimination); failure
fail-closes every predict to 1.0 (DECLINE) until a working model
loads.

### Stage 5: Evaluate POST-stage rules

POST rules see the ML score and can override it. Used for
operator escalation patterns ("if model says ACCEPT but amount
> £50k and device is untrusted, kick to manual review").

### Stage 6: Decide

The decision logic:

```
if p >= threshold[segment]:
    decision = DECLINE
elif p >= review_threshold:
    decision = REVIEW
else:
    decision = ACCEPT
```

Per-segment thresholds are seeded in `02_segment_thresholds.ts`:
CASH_OUT=0.70 (high tolerance for blocking), TRANSFER=0.30 (low
tolerance — TRANSFER is the dominant ring/laundering channel),
PAYMENT=0.50, DEBIT=0.50, CASH_IN=0.50.

### Stage 7: Reason codes

`reason-codes.ts` produces a small list of `{code, description,
contribution, value}` items explaining which features pushed the
score. This is **feature-deviation explainer** — for each named
feature, it computes how far the input is from the training
distribution's median and signs the contribution toward the
score. It is **not SHAP** — SHAP would cost ~10× the prediction
latency. The trade is honest: cheap per-prediction
explainability, with FIA available for narrative-grade depth on
declined transactions.

### Stage 8: Persist + publish

- **Audit log** — every decision writes to `decisionAuditLog` with
  model versions, scores, threshold, rule hit, reason codes,
  feature snapshot, reviewer-override fields (empty at write time).
  Failure here must never break the decision path — DB errors are
  swallowed.
- **Kafka publish** — always publish to `transactions.completed`
  (consumed by PAA and MLA, partitioned by `sender_id`). If
  `decision === DECLINE`, *also* publish to `transactions.blocked`
  (consumed only by FIA, partitioned by `transaction_id`). The
  dual publish is deliberate — FIA runs at LLM latencies and must
  never share a queue with PAA's millisecond pipeline.
- **Webhooks** — `WebhookService.publish` enqueues HMAC-signed
  delivery rows; an in-process worker drains them with exponential
  backoff.

### Stage 9: Respond

The response carries the decision, score, threshold, reason codes,
model version, audit_id, and latency. The audit_id is the handle
clients use for later override or report requests.

---

## 3. The features

### The catalogue pattern

Features are declared in a single JSON file
(`models/feature-catalog.v1.json`) plus an optional adopter
overlay (`models/feature-catalog.adopter.json`). 64 base features
across 9 categories: velocity (1m/5m/15m/1h/24h/7d), pair-level
(sender→receiver), graph (PageRank, clustering, community),
transaction (amount, type), identity (KYC outputs), receiver
(jurisdiction, FI), geographic (lat/lng deltas, IP country),
device (VPN, trust, fingerprint), calendar (hour, day-of-week,
weekend).

Each feature spec has:

```json
{
  "index": 22,
  "name": "graph_community_id",
  "category": "graph",
  "source": "paa:redis",
  "dtype": "uint8",
  "default": 0,
  "description": "Louvain community label (categorical, low cardinality)"
}
```

The `index` is the position in the model's input vector. Renumber
without retraining and you'll silently mis-score every prediction.
The `dtype` drives coercion in `compute-op-executor.ts:151-157` —
`bool` becomes 0/1, everything else becomes a numeric.

### Why the catalogue exists

Two reasons:

1. **Online/offline parity.** The same JSON drives RDA's
   `buildFeatures()` (TypeScript) and MLA's training-time feature
   assembly (Python). When you rename a feature in one, you rename
   it in both, and the schema version on the model rejects loads
   that don't match.
2. **Adopter extensibility without forking.** The overlay file
   adds adopter features via the same compute-op DSL. New feature
   → no code change, no service restart, no fork.

### Where features come from

| Source | What | When |
|---|---|---|
| `from_field` | Pull from the request body | Stage 2, synchronous |
| `from_redis` | Read PAA's `features:{senderId}` hash | Stage 2, synchronous |
| `equals` / `is_one_of` | Boolean test on another feature | Stage 2, after sources resolved |
| `ratio` | Divide one feature by another | Stage 2, after sources resolved |
| `lookup` | Categorical → numeric (e.g., country risk score) | Stage 2 |
| `numeric_bucket` | Discretise a continuous feature | Stage 2 |
| `custom` | Adopter-supplied resolver function | Stage 2, last |

The Redis features are populated asynchronously by PAA — they're
*stale by definition*. RDA's prediction is "the freshest snapshot
PAA has flushed within the last 10 seconds." On Redis cache miss,
RDA falls back to the catalogue default for that feature and
flags the audit row's `featuresDefault: true`. Predictions still
succeed; they're just less informed.

---

## 4. The model

### XGBoost in plain English

The platform's classifier is XGBoost (eXtreme Gradient Boosting),
a gradient-boosted decision tree ensemble. Read this as:

> Train a small decision tree on the data. Look at the errors.
> Train a second tree to specifically correct those errors. Look
> at the new errors. Train a third tree. Repeat. The final
> prediction is the sum of all trees' outputs, pushed through a
> sigmoid to get a probability.

Each "tree" is a sequence of `if amount > X and account_age_days <
Y then ...` splits chosen to minimise a **loss function**. For
binary classification we use log loss:

```
L(y, p) = -[y log p + (1-y) log (1-p)]
```

Translated: when the true label `y=1` (fraud), the loss is `-log
p` — it punishes you for predicting low probability. When `y=0`,
loss is `-log(1-p)` — it punishes you for predicting high
probability. Trees are added in the direction of the **gradient**
of this loss (hence "gradient boosting") — each new tree predicts
the residual error of the ensemble so far.

XGBoost-specific tricks:

- **Regularisation** in the objective: penalises tree complexity
  to prevent overfitting (`gamma`, `lambda`).
- **Histogram-based split finding**: bucketises feature values
  before searching for splits, which is what makes it fast.
- **Handles missing values natively**: each split has a "default
  direction" learned during training, so you don't have to
  impute NaN.

### Why XGBoost specifically

For tabular fraud data with mixed numeric/categorical features
and severe class imbalance, gradient-boosted trees consistently
beat neural networks on small-to-medium datasets (<10M training
rows). They're also more interpretable: every prediction can be
traced to a sequence of feature splits.

The shipped model trained on IEEE-CIS (683k train / 118k test)
hits **held-out F1 = 0.554, AUC = 0.911** — credible mid-range
performance for an open-source baseline. An adopter retraining on
their own data should expect to do somewhat better with proper
ground-truth labels and adopter-specific features.

### ONNX as a deployment format

XGBoost's native binary is Python-specific. **ONNX** (Open Neural
Network Exchange) is a portable graph format any runtime can
execute. We convert XGBoost → ONNX at training time
(`onnxmltools`) and load it in RDA via the `onnxruntime-node`
JavaScript binding.

Why: zero Python dependency in the inference path, deterministic
graph execution, p99 inference at ~49 µs. The trade: not all
XGBoost features survive conversion cleanly — newer
`onnxmltools` versions have known bugs which is why
`mla-service/requirements.txt` pins
`onnx==1.13.0`, `onnxmltools==1.10.0`, `onnxconverter-common==1.12.0`.
If you see `TypeError: Field onnx.AttributeProto.ints: Expected
an int, got a boolean`, you bumped one of those without testing
the conversion path.

### Isotonic calibration

XGBoost's raw probabilities saturate near 0 and 1 — it tends to
say "definitely fraud" or "definitely not" when it should be
saying "75% likely." This is a known weakness of margin-based
ensembles.

**Isotonic regression calibration** fixes this. The algorithm
takes (raw_probability, true_label) pairs from a 10% held-out
calibration split and fits a monotonically-increasing step
function that maps raw → calibrated:

```
calibrated = isotonic_fit(raw_score)
```

Concretely: bin the raw scores, compute the empirical fraud rate
within each bin, fit a step function with the constraint that
bins must monotonically increase in calibrated value. After
calibration, a model output of 0.75 actually means "this looks
like ~75% of the historical population that turned out to be
fraud."

We track **Brier score** before and after to verify the
calibration improved things (lower is better):

```
Brier = (1/N) × Σ(p_i - y_i)²
```

The calibrated Brier is stored in `modelVersions.brierScore`;
uncalibrated is logged in `meta.json` for the regression
comparison. The calibration bakes into the deployed booster, so
RDA reads only the ONNX score — no separate calibration step at
inference time.

### Per-segment thresholds

The same ONNX score is interpreted differently per segment via
the `segmentThresholds` table. The seeded defaults reflect
calibrated risk tolerance for the PaySim transaction-type
distribution:

| Segment | Threshold | Rationale |
|---|---|---|
| CASH_OUT | 0.70 | Customer cashing out their own money — block reluctantly |
| TRANSFER | 0.30 | Dominant channel for laundering rings — low tolerance |
| PAYMENT | 0.50 | Standard |
| DEBIT | 0.50 | Standard |
| CASH_IN | 0.50 | Lower-risk inflow but treated symmetrically by default |

Adopters retune these per market. The threshold is the most
operationally impactful number in the system — a 0.05 shift moves
the decline rate by single-digit percentage points on most
distributions.

---

## 5. The graph

PAA holds a directed graph of every sender → receiver edge
observed in the transactions stream. Nodes are user accounts
(customer wallets, agent tills, merchant accounts, bank float
accounts — anything that can move money). Edges aggregate the
relationship: weight (number of transactions), totalAmount,
firstTransaction, lastTransaction, set of transaction types.

The graph drives three feature classes the model uses: **PageRank**
(network centrality), **local clustering coefficient** (how
cliquey the immediate neighbourhood is), and **Louvain community
ID** (which cluster the user belongs to).

### PageRank — what and why

PageRank scores how "important" a node is by how much it's
pointed at by other important nodes. In fraud, hubs (cash-out
points, super-agents, drain accounts) get high PageRank — they're
where money concentrates.

The recurrence:

```
PR(u) = (1-α)/N + α × Σ_{v ∈ in(u)} (PR(v) / L(v))
```

Plain English: a node's rank is a base value `(1-α)/N` plus the
sum of incoming neighbours' ranks divided by their out-degrees.
Each incoming neighbour "votes" for `u` with a share of their
own rank.

- **α (damping)** = 0.85 by default. Models the probability that
  a random walker continues clicking versus jumping to a random
  page. Standard PageRank value.
- **N** = total nodes.
- **L(v)** = out-degree of `v`.

The algorithm is **power iteration**: start with PR(u) = 1/N for
all u, apply the recurrence, repeat until the change between
iterations is below tolerance (`1e-6`) or you hit `maxIterations`
(100). Typically converges in 20–40 iterations on a typical
transaction graph.

We use the weighted variant via `getEdgeWeight: (_, attrs) =>
attrs.weight || 1` — sender→receiver pairs that have transacted
many times carry more vote weight than one-off relationships.

### Local clustering coefficient

How tight is a node's immediate neighbourhood? Defined as:

```
C(v) = 2 × triangles(v) / (k_v × (k_v - 1))
```

- **triangles(v)** = number of pairs of v's neighbours that are
  also connected to each other.
- **k_v** = total number of v's neighbours (in + out, treated as
  undirected for this calculation).

C ∈ [0, 1]. 0 means "none of my counterparties transact with each
other"; 1 means "every pair of my counterparties also transacts
with each other."

In fraud terms: a ring's nodes have **C ≈ 1** because they
collude with each other; a normal customer transacting with
random merchants has **C ≈ 0** because those merchants don't
transact with each other.

### Louvain community detection

Louvain partitions the graph into **communities** — groups of
nodes that transact more with each other than with the rest of
the graph. The metric being optimised is **modularity**:

```
Q = (1 / 2m) × Σ_{i,j} [A_ij - (k_i × k_j) / (2m)] × δ(c_i, c_j)
```

Where:
- **m** = total edge weight
- **A_ij** = weight of edge between i and j
- **k_i**, **k_j** = degrees of nodes i, j
- **c_i**, **c_j** = community labels
- **δ(c_i, c_j)** = 1 if same community, 0 otherwise

In plain English: modularity rewards you for putting nodes in the
same community when they have more edges between them than you'd
expect by random chance (given their degrees). The expected
random weight between i and j is `k_i × k_j / 2m` — modularity
subtracts that off so dense hubs don't get credit for being
heavily connected to everyone.

The Louvain algorithm itself is greedy:

1. Start with each node in its own community.
2. For each node, compute the modularity gain of moving it to
   each of its neighbours' communities. Move it to whichever gain
   is highest (if positive). Repeat until no node wants to move.
3. Treat each community as a super-node. Recurse on this
   coarsened graph.

The output is a partition: a function from node ID → community ID
(integer). Two important properties:

- **Community labels are not deterministic.** Run Louvain twice
  on the same graph and the community structure will likely be
  similar but the integer labels assigned to those communities
  are arbitrary. This is a known limitation we treat seriously —
  see [`ROADMAP.md`](../ROADMAP.md) "Derived community features
  replace raw `community_id`."
- **Resolution limit.** Louvain has a known bias toward
  communities of a certain size relative to graph density. Very
  small communities (<5 nodes) get absorbed; very large ones get
  split. We currently don't apply a size gate to community IDs;
  that's also tracked in the roadmap.

### When the graph recomputes

PageRank, clustering, and Louvain run together inside
`computeNetworkMetrics()` (`paa-service/src/services/graph.service.ts:155`).
The trigger fires under three conditions:

- **Scheduled tick** — every `GRAPH_UPDATE_INTERVAL` (default
  5 min). Catch-all for slow drift.
- **Event-count tick** — every 100 transactions. Catches busy
  bursts the scheduled tick would miss.
- **Triangle-close trigger** — when a new edge closes a directed
  3-cycle (`A → B`, `B → C` already exists, `C → A` already
  exists), increment `dirtyTriangleCount`. The next event past a
  10s throttle (`TRIANGLE_RECOMPUTE_MIN_INTERVAL_MS`) fires the
  recompute. This collapses ring-detection latency from "up to
  5 minutes" to "within one event of the ring forming."

Each recompute is a **full rebuild** — the `graphology-communities-louvain`
library doesn't expose warm-starts. PageRank, clustering, and
Louvain all run from scratch over the whole graph. Cost at small
scale (<10k nodes) is single-digit milliseconds; at 1M nodes it
becomes hundreds of ms to seconds. See [`ROADMAP.md`](../ROADMAP.md)
"Streaming / incremental community detection" for the long-term
plan.

### Velocity windows

Alongside the graph, `velocity.service.ts` maintains per-user
rolling windows: count of transactions in the last 1h / 24h / 7d,
mean and standard deviation of amount over the last 30 d, time
since last transaction. Capped at 1,000 records per user (the
`MAX_TRANSACTIONS_PER_USER` constant); the oldest gets shifted
off when a new one arrives.

Velocity catches one-off anomalies — out-of-baseline send rate,
amount z-score, unusual time-of-day. These are signals the model
can use from the very first transaction the user ever sends, well
before the graph has enough structure to fire.

---

## 6. Training

MLA's job is to retrain the model on accumulated ground-truth
data and promote successful candidates to production. The full
loop is in `mla-service/src/main.py`; key sub-modules below.

### Data loading

`data_loader.py:load_labeled()` runs a SQL query that:

1. Reads every row in `transactions` where
   `COALESCE(groundTruthFraud, fraudLabel) IS NOT NULL` — i.e.,
   we have a label.
2. Filters to `decisionSource IS NULL OR decisionSource = 'ML'`
   so rule-driven DECLINEs don't pollute the training set (we'd
   end up teaching the model to replicate the rule, which is
   redundant — the rule is already deterministic).
3. Orders `groundTruthFraud IS NOT NULL DESC` so reviewer-verified
   rows come first within the row limit (`TRAINING_DATA_SIZE`).

### Class imbalance — SMOTE

Even after labelling, fraud rows are scarce — typically 1–5% of
the labelled set. Training XGBoost on this directly produces a
model biased toward "not fraud." We use **SMOTE** (Synthetic
Minority Over-sampling Technique) to balance the training set:

1. For each minority-class point, find its `k` nearest minority
   neighbours (default k=5).
2. Pick one of those neighbours at random.
3. Generate a synthetic minority point on the line between them
   at a random position.
4. Repeat until the classes are balanced (or until you reach the
   over-sampling ratio).

SMOTE only modifies the training set — the held-out test set
keeps its original imbalance, so reported F1 / AUC reflect
real-world performance. Critically, calibration data must come
from the *real* distribution, which is why the calibration
fitting happens on a separate 10% held-out split that hasn't
been SMOTEd.

### Train/test split

Stratified split — 80/10/10 (train / calibration / test) by default,
preserving the fraud-rate proportion in each fold. The
calibration split is the input to isotonic regression; the test
split is the held-out evaluation set the promotion gate measures
on.

### Training output

- `model.onnx` — the deployable ONNX model
- `model.json` — XGBoost's native dump (kept for debugging /
  importance plots)
- `scaler.npz` — the StandardScaler fit on training features,
  needed at inference time
- `meta.json` — calibrated and uncalibrated Brier, F1, AUC,
  training size, feature schema version, training-mode flag,
  whether SMOTE was applied, isotonic curve checkpoint

A copy lands in `models/versions/v<version>/` for lineage; the
ACTIVE model is deployed by copying or symlinking into
`models/fraud_model.onnx` for RDA, plus a registry-row transition
to `ACTIVE`.

### Training modes

Operators choose via `mlaSettings.trainingMode`:

- **FRESH** — train from scratch on all available labelled data.
  Current default. Safer when data has shifted significantly.
- **CONTINUED** — seed XGBoost with the current production model
  (via `xgb_model=` parameter), add
  `continuedTreesPerRound` additional trees, fine-tune. Cheaper
  per retrain, preserves learnt structure, but compounds bias if
  recent labels are skewed.

The choice is exposed in the Sentinel settings page; adopters
pick the trade per market.

---

## 7. Drift detection

Models degrade over time. Customer behaviour changes,
fraudster tactics evolve, the calendar moves. MLA monitors two
signals continuously and triggers a retrain when either crosses a
threshold.

### F1 drift

The simplest signal: F1 score over recent decisions versus the
baseline F1 the model was promoted at. If `current_F1 <
DRIFT_F1_THRESHOLD` (default 0.92), trigger retrain.

This catches the obvious case where the model has stopped
working. It's lagging — by the time F1 has dropped meaningfully
you've already let degraded predictions through for a while.

### PSI on input distribution

**Population Stability Index** measures how much an input
feature's distribution has shifted between two periods. Formula
for a single feature, bucketised into bins:

```
PSI = Σ_i [(P_i - Q_i) × ln(P_i / Q_i)]
```

Where `P_i` is the proportion of the current period in bucket
`i`, and `Q_i` is the proportion of the baseline period in
bucket `i`. Sum across all buckets.

Conventional interpretation:

| PSI | Meaning |
|---|---|
| < 0.10 | No significant shift |
| 0.10 – 0.25 | Moderate shift — investigate |
| > 0.25 | Large shift — retrain |

We track PSI on the `amount` feature specifically
(`DRIFT_PSI_THRESHOLD=0.25`) because amount distributions are the
most reliable early signal of macro change (inflation, market
events, new product launches). Other features can drift too;
adopters extending the drift surface is on the roadmap.

PSI is leading where F1 is lagging — you can spot a distribution
shift before it has visibly hurt model performance, and retrain
ahead of the F1 dip.

---

## 8. Investigation (FIA / LLM)

FIA is opt-in (gated behind `docker compose --profile fia`)
because it ships ~7.6 GB of Phi-3-mini-4k-instruct weights and
needs ~16 GB RAM to run. When enabled, it consumes every
`DECLINE` decision from `transactions.blocked` and produces a
structured investigation report.

### The model

**Phi-3-mini-4k-instruct** is Microsoft's small open-weights LLM
(3.8B parameters, fp16 = ~7.6 GB on disk). "Instruct" = fine-tuned
to follow structured prompts. We use it unmodified — no
fine-tuning step on top.

Device selection (`LLM_DEVICE`):
- `auto` (default): CUDA if available → MPS (Apple Silicon) →
  CPU
- On Apple Silicon, the first generation triggers a 6–10 min
  one-time MPS kernel compilation. Steady-state is ~40–90s per
  report on M-class chips, ~10–20s on a single decent GPU, and
  several minutes on CPU.

### The prompt

Structured prompt asks for JSON output with fixed fields:

```json
{
  "verdict": "FRAUD" | "LIKELY_FRAUD" | "INCONCLUSIVE" | "LIKELY_LEGITIMATE",
  "recommendedAction": "BLOCK" | "REVIEW" | "RELEASE",
  "confidence": 0.0 - 1.0,
  "keyIndicators": ["string", ...],
  "narrative": "string (free-form)"
}
```

The structure is enforced by the prompt template plus a JSON
schema validator on the LLM output. If the LLM returns malformed
JSON, we retry once, then fall back to a deterministic rule-based
report so the pipeline still produces a parseable row
(`FIA_FALLBACK_ON_LLM_FAILURE=true` by default).

### Operational discipline

- **Idempotency**: `investigationReports.transactionId` is UNIQUE
  with `INSERT ... ON CONFLICT DO NOTHING`. A duplicate
  consumption produces no second report.
- **Per-partition offset commit**: never `consumer.commit()` with
  no args, which would advance offsets across partitions.
- **Slow generation = small batches**: `max_poll_records=1`,
  `max_poll_interval_ms=600000` — the consumer is configured to
  process one message and block, because a single generation can
  take a minute and we mustn't trigger a rebalance mid-call.
- **Poison-message bounding**: in-memory retry counter
  (`MAX_RETRIES=3`); after that the offset is committed and the
  failure is logged loudly so a true bad message cannot wedge a
  partition forever.
- **Never on the hot path**: FIA's HTTP API on port 9094 is for
  on-demand reports and conversational follow-ups; it has its
  own database table (`investigationReports`,
  `investigationConversations`) and never touches RDA's predict
  path.

### What FIA is and isn't

**Is**: a narrative investigator that turns a blocked transaction
+ its context into something an analyst can read in 30 seconds.

**Isn't**: a decision authority. The LLM's `verdict` is advisory
— it does not override the model's DECLINE, and reviewers can
disagree with it. The report's value is in the keyIndicators +
narrative, which help the analyst quickly understand *why* the
transaction looked suspicious.

---

## 9. Rules engine

The rules engine sits alongside the ML model rather than
replacing it. Three reasons:

1. **Compliance.** Some decisions must be deterministic and
   auditable. "Block all transfers to OFAC-sanctioned
   jurisdictions" is not an ML decision; it's a regulatory
   requirement.
2. **Cold-start.** A new account with no history has zero useful
   ML features. Rules cover this gap.
3. **Operator velocity.** An analyst spotting a new pattern can
   ship a rule in 30 seconds; an ML retrain takes hours.

### The DSL

JSON-Logic-style predicates evaluated by
`src/shared/rules/rules.engine.ts`. Supported ops are deliberately
narrow — predicates and combinators only, no arithmetic:

- `var` — reference a feature
- `==`, `!=`, `>`, `>=`, `<`, `<=` — comparisons
- `and`, `or`, `not` — combinators
- `in` — membership

Example (structuring rule):

```json
{
  "and": [
    { "==": [{ "var": "transaction_type" }, "CASH_OUT"] },
    { ">=": [{ "var": "velocity_24h" }, 4] },
    { ">=": [{ "var": "amount" }, 80000] },
    { "<=": [{ "var": "amount" }, 99999] }
  ]
}
```

In plain English: four or more cash-out transactions in 24
hours, each between 80k and 100k (just under the 100k reporting
threshold).

### Stages

- **PRE**: evaluated before ML. A matching PRE rule
  short-circuits the model entirely — its `action` becomes the
  decision (`DECLINE`, `REVIEW`, or `ACCEPT`). Use for mandatory
  blocks and overrides.
- **POST**: evaluated after ML. Sees the score and can override.
  Use for escalation patterns ("model says ACCEPT but amount >
  threshold + device untrusted → REVIEW").

### Hot reload

Rules are stored in `rules` table. The service polls every
`RULES_RELOAD_INTERVAL_MS` (30s default) and additionally
listens on a Redis pubsub channel (`rules:invalidate`) for
immediate reloads. Operators editing in Sentinel see effects
within seconds.

### The FATF rule pack

Five default rules under `src/database/seeds/03_fatf_rule_pack.ts`:

1. **Structuring** — pattern above.
2. **VPN + significant amount** — high-amount transaction from a
   VPN IP.
3. **High-risk corridor TRANSFER** — outbound transfer to a FATF
   high-risk jurisdiction.
4. **ATO signature** — short session-to-transaction time + cross-
   country IP + high amount.
5. **Untrusted device + significant amount** — non-recognised
   device fingerprint + amount above threshold.

Defaults are NGN-tuned. Adopters re-thresholding for their
market is the first thing to do post-deploy.

---

## 10. Operational mechanics

The plumbing that makes the system safe to run.

### Circuit breakers

`opossum` library wraps Redis feature retrieval and ONNX
inference. The breaker opens (= stops calling the underlying
service) when failure rate exceeds a threshold and resets after
a cooldown. While open:

- Redis breaker open → predictions use catalogue defaults for
  every feature.
- ONNX breaker open → fail-closed to 1.0 (DECLINE).

The trade is deliberate: a Redis outage degrades accuracy but
preserves throughput; an ONNX outage stops accepting traffic
rather than serving random predictions.

### Idempotency keys

The `Idempotency-Key` header on `/v1/predict` is hashed together
with `(tenantId, requestHash)` and looked up in `idempotencyKeys`
(in-memory cache + DB fallback). Same key + same body → cached
response with `Idempotency-Replay: true`. Same key + different
body → 422 (the caller's bug, not ours).

The replay window is bounded (defaults to ~24h) to keep the cache
finite. Outside the window, repeat calls re-run through the
predict pipeline.

### HMAC webhook signatures

Webhook deliveries are signed with HMAC-SHA256 using a
per-subscription secret:

```
signature = "sha256=" + hex(HMAC-SHA256(secret, timestamp + "." + body))
```

The `X-Webhook-Signature` header carries this; `X-Webhook-Timestamp`
carries the timestamp. Adopters verify by recomputing on their
end. We use `crypto.timingSafeEqual` for the comparison to prevent
timing attacks. See [`WEBHOOKS.md`](WEBHOOKS.md) for the verifier
reference implementation.

### API keys

`fdk_<prefix>_<secret>` format, where prefix is a non-secret
identifier and secret is 32 bytes of randomness. We store only
the SHA-256 hash of the full token, never the secret itself.
Verification reads the hash row, hashes the provided token,
compares with `crypto.timingSafeEqual`. A 30-second verification
cache means hot-loop callers don't pay the hash cost per request.

### Auth and JWT

User passwords are bcrypt-hashed (cost 12 by default). On
`POST /v1/auth/login`, RDA issues a JWT signed with
`AUTH_JWT_SECRET` containing a snapshot of the user's
permissions. The snapshot is deliberate — changing a user's role
takes effect only on next login, which keeps every per-request
permission check a constant-time JWT verification instead of a
database hit.

### Audit log

`decisionAuditLog` is written on every `/v1/predict` regardless
of decision outcome. The write must never break the decision path
— if the DB is down, the audit row is dropped and the request
still succeeds (logged at ERROR for the operator). Reviewer
overrides update the same row's `overrideDecision`,
`overrideReason`, `reviewedBy`, `reviewedAt` fields without
mutating the original `finalDecision` — both the original
verdict and the human verdict stay on the row for posterity.

---

## 11. Adversarial considerations

What the system defends against, what it doesn't (yet).

### Defended

- **Self-labelling feedback loop.** PAA writes `fraudLabel = NULL`
  on every new row. Reviewer overrides write to `groundTruthFraud`.
  The model never trains on its own past decisions.
- **Rule-driven training pollution.** MLA's training query
  excludes rows where `decisionSource != 'ML'`, so the model
  doesn't try to relearn the rules.
- **Offline/online feature skew.** The catalogue is shared
  between RDA and MLA; the schema version is baked into every
  model's `meta.json` and enforced at load time.
- **Replay attacks on webhooks.** HMAC signature includes the
  timestamp; reverification rejects deliveries outside a window.
- **API-key extraction from logs.** Only the SHA-256 hash is
  stored; raw `fdk_...` tokens are never logged, never written to
  audit rows.
- **Cold-start prediction failure.** Redis cache miss falls back
  to catalogue defaults; predictions degrade rather than fail.
- **Race conditions on review queue claims.** Atomic claim via DB
  row update with `WHERE reviewedAt IS NULL` so two reviewers
  can't claim the same case.

### Known gaps (tracked in [`ROADMAP.md`](../ROADMAP.md))

- **Graph poisoning.** No edge-weight cap, no minimum-amount
  filter on graph admission. An adversary can inflate a target's
  PageRank by spraying small transactions toward them from
  controlled accounts.
- **Adversarial drift.** Fraudsters notice when their pattern
  starts getting blocked and pivot. PSI catches the resulting
  distribution shift; the response time depends on retrain
  cadence.
- **Community ID as ordinal.** Louvain's integer labels flow into
  the model as a numeric feature, but the labels aren't stable
  across runs. Tracked under "Derived community features replace
  raw `community_id`."
- **Prompt injection in FIA.** Transaction fields flow into the
  Phi-3 prompt — sender ID, narrative, request context — and
  attacker-controlled values could attempt to escape the system
  prompt. We treat this as in-scope for security disclosure (see
  [`SECURITY.md`](../SECURITY.md)) but don't yet have a hardened
  prompt-sanitisation layer.

---

## 12. Glossary

**ACCEPT / DECLINE / REVIEW** — the three possible decisions.
ACCEPT clears the transaction. DECLINE blocks it and emits a
`transactions.blocked` event (which FIA consumes). REVIEW sends
it to the human queue in Sentinel.

**Account takeover (ATO)** — see §1.

**AML / KYC / FATF / SAR** — see §1.

**AUC-ROC (Area Under the Receiver Operating Characteristic
curve)** — a single-number summary of a classifier's
discrimination ability across all decision thresholds. 0.5 =
random, 1.0 = perfect. Reasonable fraud models score 0.85–0.95.

**Brier score** — calibration metric, MSE between predicted
probabilities and binary outcomes. Lower is better. Distinguishes
"is the model calibrated" from "is the model discriminative" —
two different questions both worth answering.

**Bust-out** — see §1.

**Calibration** — the alignment between a model's predicted
probability and the empirical event rate. A well-calibrated model
that says "75% fraud" should be right 75% of the time on the
population it says that about.

**Champion / challenger / shadow** — the model lifecycle.
Champion is the model in production making decisions. Shadow is
the candidate also scoring every request for offline comparison
but not driving the decision. Challenger is a candidate being
tested via SHADOW or canary traffic split before promotion.

**Circuit breaker** — failure-isolation pattern. After N
failures the breaker "opens" and stops calling the downstream;
calls fail fast (or fall back to defaults) instead of queuing.
After a cooldown the breaker "half-opens" and probes recovery.

**CNP (Card-Not-Present)** — see §1.

**Decision audit log** — every `/v1/predict` writes a row to
`decisionAuditLog` with the full decision context. This is the
source of truth for "what did the system decide and why."

**Drift** — change in the input data distribution or the
underlying fraud patterns over time. F1 drift = the model is
underperforming; PSI drift = the inputs themselves have shifted.

**F1 score** — harmonic mean of precision and recall.
`F1 = 2 × precision × recall / (precision + recall)`. Single
number useful for imbalanced classification — penalises both
false positives and false negatives.

**False positive (FP)** — predicted fraud, was legitimate.
**False negative (FN)** — predicted legitimate, was fraud.
**True positive (TP)** / **True negative (TN)** — correct
predictions.

**Feature catalogue** — see §3.

**Feature skew (online/offline skew)** — the bug where the
features computed at training time and at serving time disagree.
A model trained on one shape of input and served on another
silently mis-predicts. The shared catalogue defends against this.

**Friendly fraud** — see §1.

**Ground truth** — verified fraud labels (chargebacks, reviewer
overrides). Distinguished from the system's own decisions (which
are NOT ground truth).

**HMAC** — Hash-based Message Authentication Code. Used for
webhook signatures; lets the receiver verify both message
integrity and sender authenticity using a shared secret.

**Idempotency** — same request, same response, regardless of how
many times it's submitted. The `Idempotency-Key` header carries
the caller's claim of identity for a request; we cache the
response keyed by `(tenantId, key, requestHash)`.

**Isotonic regression** — see §4 (calibration).

**JSON-Logic** — the predicate DSL used by the rules engine.
Boolean expressions over feature values, no arithmetic.

**Louvain** — see §5.

**McNemar's test** — paired-sample statistical test for
comparing two classifiers on the same test set. Test statistic
`χ² = (|b - c| - 1)² / (b + c)` where `b` = champion-right /
challenger-wrong count, `c` = champion-wrong / challenger-right
count. Required at `p < 0.05` for promotion gate.

**Money mule** — see §1.

**ONNX** — see §4.

**PageRank** — see §5.

**Phi-3-mini** — see §8.

**Population Stability Index (PSI)** — see §7.

**Power iteration** — the iterative method behind PageRank.
Repeatedly apply the recurrence until convergence; mathematically
equivalent to finding the dominant eigenvector of the link matrix.

**Precision** — of the things we predicted as fraud, how many
actually were. `TP / (TP + FP)`. High precision = low false
positives = customer-friendly.

**Recall (sensitivity)** — of the things that actually were
fraud, how many did we catch. `TP / (TP + FN)`. High recall =
low false negatives = effective at catching fraud.

**Ring** — see §1.

**Segment** — the routing dimension for thresholds. By default
maps to `transaction_type` (CASH_OUT, TRANSFER, ...) but can be
overridden per-request.

**SHAP** — SHapley Additive exPlanations. A game-theoretic
feature-attribution method; gives per-prediction feature
contributions. We don't use it on the hot path because of cost;
the reason codes use a cheaper feature-deviation explainer
instead.

**SMOTE** — see §6.

**Structuring** — see §1.

**Synthetic identity** — see §1.

**Threshold** — the probability cutoff at which a score
becomes a DECLINE decision. Per-segment, stored in
`segmentThresholds`.

**XGBoost** — see §4.
