# Documentation Index

Adopter-facing reference for the platform's adoption features. Each
file is a single-purpose reference, focused on what an integrator needs
to wire one capability up. For architecture-level notes, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

| Document                                  | Covers                                                                 |
|-------------------------------------------|------------------------------------------------------------------------|
| [`AUTH.md`](AUTH.md)                      | API-key issuance, verification, rate limit, admin token, rotation.     |
| [`AUDIT.md`](AUDIT.md)                    | `decisionAuditLog` schema, SQL recipes, reviewer overrides, retention. |
| [`REASON-CODES.md`](REASON-CODES.md)      | Inline per-decision explanations: catalogue, math, localisation.       |
| [`RULES.md`](RULES.md)                    | Pre/post rules engine, the JSON DSL, examples, failure isolation.      |
| [`MODEL-REGISTRY.md`](MODEL-REGISTRY.md)  | Model lifecycle (CANDIDATE → SHADOW → ACTIVE), per-segment thresholds. |
| [`WEBHOOKS.md`](WEBHOOKS.md)              | Subscribing, payload schemas, signature verification, retry model.     |
| [`IDEMPOTENCY.md`](IDEMPOTENCY.md)        | `Idempotency-Key` semantics, scoping, TTL, conflict handling.          |
| [`FIA-API.md`](FIA-API.md)                | On-demand investigation reports and conversational follow-ups.         |

For the high-level feature catalogue (with what's implemented vs
follow-up), see [`../IMPROVEMENTS.md`](../IMPROVEMENTS.md).
