# Documentation Index

Adopter-facing reference for the platform's adoption features. Each
file is a single-purpose reference, focused on what an integrator needs
to wire one capability up. For architecture-level notes, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

| Document                                  | Covers                                                                 |
|-------------------------------------------|------------------------------------------------------------------------|
| [`PREDICT-API.md`](PREDICT-API.md)        | `POST /v1/predict` — full request shape, headers, response, all errors. |
| [`AUTH.md`](AUTH.md)                      | API-key issuance, verification, rate limit, rotation.                 |
| [`AUTHZ.md`](AUTHZ.md)                    | User login, JWT sessions, roles, permission catalogue, admin guards.   |
| [`AUDIT.md`](AUDIT.md)                    | `decisionAuditLog` schema, SQL recipes, reviewer overrides, retention. |
| [`REASON-CODES.md`](REASON-CODES.md)      | Inline per-decision explanations: catalogue, math, localisation.       |
| [`RULES.md`](RULES.md)                    | Pre/post rules engine, the JSON DSL, examples, failure isolation.      |
| [`MODEL-REGISTRY.md`](MODEL-REGISTRY.md)  | Model lifecycle (CANDIDATE → SHADOW → ACTIVE), per-segment thresholds. |
| [`FEATURES.md`](FEATURES.md)              | Feature catalogue (64 base + adopter overlay), compute ops, schema versioning. |
| [`FRAUD_SIMULATION.md`](FRAUD_SIMULATION.md) | Persona-driven detection benchmark; run it against your own stack.   |
| [`TRAINING.md`](TRAINING.md)              | Adopter walkthrough — load data, train, register, activate.            |
| [`WEBHOOKS.md`](WEBHOOKS.md)              | Subscribing, payload schemas, signature verification, retry model.     |
| [`IDEMPOTENCY.md`](IDEMPOTENCY.md)        | `Idempotency-Key` semantics, scoping, TTL, conflict handling.          |
| [`FIA-API.md`](FIA-API.md)                | On-demand investigation reports and conversational follow-ups.         |
| [`FRONTEND.md`](FRONTEND.md)              | Sentinel operator dashboard — layout, auth, offline mode, extending.   |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | Common symptoms on a fresh install and what each one means.           |

For what's planned next, see [`../ROADMAP.md`](../ROADMAP.md). For the
per-release history, see [`../CHANGELOG.md`](../CHANGELOG.md).
