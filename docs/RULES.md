# Rules Engine

A tiny JSON-Logic-style expression evaluator that lets operators block,
allow, or flag transactions without changing code or retraining the
model.

## Lifecycle

1. Operator creates a rule via `POST /v1/admin/rules`.
2. The row lands in the `rules` table.
3. Every RDA replica reloads active rules from Postgres every
   `RULES_RELOAD_INTERVAL_MS` (default `30000`).
4. On the next prediction, the new rule is in effect.

There is no per-request DB lookup — rules are held in memory and
evaluated against the request context.

## Stages

Each rule fires in one of two stages:

- **PRE** — evaluated **before** the ML model. A match short-circuits
  the pipeline; the ML model is not called. Use for hard
  allowlists / blocklists, hard amount caps, instant kill switches.
- **POST** — evaluated **after** the ML model. A match overrides the
  ML decision. Use for "if score is borderline AND velocity is high,
  send to manual review" style logic.

A rule's `priority` controls evaluation order within a stage (lower
fires first). The first matching rule wins; later rules in the same
stage are skipped.

## Actions

| Action     | Effect on the final decision |
|------------|-----------------------------|
| `ALLOW`    | Force `ACCEPT`.             |
| `DENY`     | Force `DECLINE`.            |
| `REVIEW`   | Force `REVIEW` — neither approved nor blocked; routed to a human reviewer. |
| `NONE`     | Match is recorded but does not change the decision. Useful for tagging. |

When a rule fires, the audit row records `ruleId`, `ruleName`,
`ruleStage`, and `decisionSource` (`PRE_RULE` or `POST_RULE`).

## Expression DSL

Expressions are JSON trees. Operators take their operands as JSON
arrays. Leaves are literals or `{ "var": "<path>" }` references.

| Operator        | Form                                           | Notes                                |
|-----------------|------------------------------------------------|--------------------------------------|
| Variable        | `{ "var": "amount" }`                          | Dot paths supported: `features.velocity_1h`. |
| Equality        | `{ "==": [a, b] }`                             | Loose equality (string `"5"` equals number `5`). |
| Inequality      | `{ "!=": [a, b] }`                             |                                      |
| Numeric compare | `{ ">": [a, b] }`, `>=`, `<`, `<=`              | Operands coerced to number.          |
| Boolean and     | `{ "and": [expr, expr, ...] }`                  | Short-circuits.                      |
| Boolean or      | `{ "or": [expr, expr, ...] }`                   | Short-circuits.                      |
| Negation        | `{ "not": expr }`                              |                                      |
| Membership      | `{ "in": [value, [literal, literal, ...]] }`    | Haystack can be array or string.     |

Unsupported by design (keeps the engine cheap and auditable):
arithmetic, regular expressions, string functions, user-defined
functions, time math.

## Available context

Variables you can reference in `{ "var": "..." }`:

- `transaction_id`, `sender_id`, `receiver_id`, `amount`,
  `transaction_type`, `timestamp`, `segment`, `tenant_id`.
- `features.<name>` — every snapshot feature used by reason codes:
  `velocity_1h`, `velocity_24h`, `velocity_7d`, `avg_amount_30d`,
  `std_amount_30d`, `pagerank`, `clustering_coef`,
  `time_since_last_txn`, `is_weekend`, `hour_of_day`, `amount`,
  `transaction_type_code`.
- POST-stage only: `ml_score` (float in `[0,1]`), `ml_decision`
  (`"ACCEPT"` / `"DECLINE"`).

## Default rule packs

`npm run db:seed` installs three packs out of the box. All are
idempotent — they skip rules whose `name` already exists, so adopters
can edit, disable, or delete them post-seed without re-introducing the
defaults on the next seed run. The FATF and behavioral packs seed
active; the demo pack seeds inactive unless `SEED_DEMO_RULES_ACTIVE=true`.

### Pack 1: demo rules (`01_demo_rules.ts`)

Four PRE-stage rules keyed on `amount` / `transaction_type` / `segment`
so the `data/demo/sample-transactions.json` dataset produces a visible
mix of ACCEPT / REVIEW / DECLINE on a fresh deploy with no PAA cache.
Adopters running on real data will typically want to delete these.

### Pack 2: FATF default pack (`03_fatf_rule_pack.ts`)

Five rules grounded in FATF money-laundering and account-takeover
typologies. **Default thresholds are tuned for the Nigerian retail
market (NGN, ₦5M cash-transaction-reporting threshold). Edit per
market.**

| Name | Stage | Action | What it catches |
|---|---|---|---|
| `fatf: structuring under cash-reporting threshold` | PRE | REVIEW | `CASH_OUT` sized between ₦4.5M and ₦4.999M — just under the NFIU cash-transaction-reporting line, a classic structuring signal. |
| `fatf: VPN with significant amount` | PRE | REVIEW | `ip_is_vpn=true` AND `amount ≥ ₦100k`. VPN alone isn't a fraud signal, but VPN+meaningful-money is. |
| `fatf: TRANSFER to FATF high-risk corridor` | PRE | REVIEW | Outbound `TRANSFER` whose `destination_country` is on the FATF black/grey list (`IR`, `KP`, `MM`, `SY`, `BY`). Extend with your own country-risk additions. |
| `fatf: account-takeover signature` | PRE | DENY | Rushed session (`session_to_txn_seconds ≤ 10`) AND large amount (`≥ ₦1M`) AND IP country ≠ transaction country. Deny outright — this combination is rarely benign. |
| `fatf: untrusted device with significant amount` | POST | REVIEW | `device_is_trusted=false` AND `amount ≥ ₦200k`. Runs after ML so a borderline-fraud score combined with an untrusted device is escalated. |

Adopters in other markets should review the amount thresholds in
`src/database/seeds/03_fatf_rule_pack.ts` and either edit the file
before seeding, or update the rules post-seed via
`PATCH /v1/admin/rules/:id`. The high-risk corridor list is
deliberately conservative — extend it with your own AML risk
classifications.

### Pack 3: behavioral rules (`04_behavioral_rule_pack.ts`)

Two POST-stage rules that turn PAA's velocity/graph signals into
verdicts the ML model misses on trusted, authenticated traffic. Both
route to REVIEW (analyst queue), which also generates a label for the
retraining loop.

| Name | Stage | Action | What it catches |
|---|---|---|---|
| `behavioral: velocity spike (non-agent, non-corporate)` | POST | REVIEW | `features.velocity_1h ≥ 15` on an individual account — the velocity-anomaly signature (rapid burst) the model scores as legitimate when the session looks trusted. |
| `behavioral: high fan-out spray (non-agent, non-corporate)` | POST | REVIEW | `features.unique_receivers_24h ≥ 12` on an individual account — paying out to many distinct receivers, the fan-out signature of a spray or a freshly recruited disburser. |

Both rules exclude agents (`is_agent_assisted = 0`) and corporates
(`customer_is_corporate = 0`): mobile-money agents and payroll accounts
are legitimately high-velocity / high-fan-out. Every PAA signal these
rules read defaults to 0 on a Redis cache miss, so the pack stays silent
until PAA has accumulated real state — no cold-start false positives.

Measured against the efficacy-validation harness (`efficacy-validation/`):
the pack lifts velocity-anomaly recall from 0.00 to 0.80 while adding
**zero** false positives across agent-network, payroll, airtime, and
diaspora-remittance legitimate traffic. Mule networks and rings remain
below rule reach — their signal is behavioral-over-time, which is the
ML model's job, not a single-feature threshold. Tune the two thresholds
in `04_behavioral_rule_pack.ts` to your own traffic's velocity profile.

## Examples

### Instant blocklist

```json
{
  "name": "blocklist-mules",
  "stage": "PRE",
  "priority": 10,
  "action": "DENY",
  "expression": {
    "in": [{ "var": "sender_id" }, ["mule_001", "mule_002", "mule_003"]]
  }
}
```

### Hard amount cap (no ML call needed)

```json
{
  "name": "deny-impossibly-large-cash-out",
  "stage": "PRE",
  "priority": 20,
  "action": "DENY",
  "expression": {
    "and": [
      { "==": [{ "var": "transaction_type" }, "CASH_OUT"] },
      { ">": [{ "var": "amount" }, 10000000] }
    ]
  }
}
```

### Borderline-score review

```json
{
  "name": "review-borderline-high-velocity",
  "stage": "POST",
  "priority": 50,
  "action": "REVIEW",
  "expression": {
    "and": [
      { ">=": [{ "var": "ml_score" }, 0.5] },
      { "<":  [{ "var": "ml_score" }, 0.7] },
      { ">":  [{ "var": "features.velocity_1h" }, 10] }
    ]
  }
}
```

### Tenant-scoped allowlist

Set `tenantId` on the rule; only requests with a matching
`req.apiKey.tenantId` (or `X-Tenant-Id` header) will see this rule.

```json
{
  "tenantId": "acme-sandbox",
  "name": "sandbox-allow-test-users",
  "stage": "PRE",
  "priority": 5,
  "action": "ALLOW",
  "expression": { "in": [{ "var": "sender_id" }, ["test_001", "test_002"]] }
}
```

## Disabling without deleting

```bash
curl -X PATCH http://localhost:3000/v1/admin/rules/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "isActive": false }'
```

Inactive rules are filtered at reload time and never evaluated.

## Failure isolation

If a rule expression throws (bad shape, unknown operator, type
mismatch), the evaluator logs the error and skips that rule for the
current request — it does **not** fail the prediction. This keeps a
typo in one rule from taking down the whole pipeline.
