"""
Prompt templates for the Fraud Investigation Agent.

The LLM is instructed to emit a strict JSON object so we can parse it
deterministically. We use the Phi-3 instruction format (<|user|>...<|end|>
<|assistant|>) which the model was trained on.
"""

import json
from typing import Any, Dict


SYSTEM_INSTRUCTION = """You are a senior fraud investigator at a Nigerian mobile money provider. \
You analyse transactions that the upstream ML model has flagged as fraud and produce a structured \
investigation report. You consider the ML probability, transaction context, sender history, and \
typical Nigerian mobile money fraud patterns (account takeover, SIM swap, mule networks, \
authorized push payment scams, agent fraud)."""


SCHEMA_INSTRUCTION = """Respond with a single JSON object and no other text. The object MUST contain:
- verdict: one of "FRAUD_CONFIRMED", "LIKELY_LEGITIMATE", "UNCERTAIN"
- agent_confidence: float between 0 and 1
- recommended_action: one of "BLOCK", "CONTACT_CUSTOMER", "MANUAL_REVIEW", "RELEASE"
- key_indicators: array of short strings (3-6 items) naming the signals that drove your verdict
- narrative: 3-5 sentence plain-English explanation an analyst can paste into a case file"""


def build_prompt(event: Dict[str, Any], template_version: str = "v1") -> str:
    """Render the prompt for a blocked-transaction event."""
    facts = {
        "transaction_id": event.get("transaction_id"),
        "sender_id": event.get("sender_id"),
        "receiver_id": event.get("receiver_id"),
        "amount_naira": event.get("amount"),
        "transaction_type": event.get("transaction_type"),
        "ml_fraud_probability": event.get("fraud_probability"),
        "ml_decision": event.get("decision"),
        "device": event.get("device_fingerprint") or {},
        "timestamp_unix": event.get("timestamp"),
    }
    facts_json = json.dumps(facts, indent=2, default=str)

    user_block = (
        f"{SCHEMA_INSTRUCTION}\n\n"
        f"Transaction under investigation:\n```json\n{facts_json}\n```\n\n"
        f"Produce the JSON report now."
    )

    # Phi-3 instruction format
    return (
        f"<|system|>\n{SYSTEM_INSTRUCTION}\n<|end|>\n"
        f"<|user|>\n{user_block}\n<|end|>\n"
        f"<|assistant|>\n"
    )
