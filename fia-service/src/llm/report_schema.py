"""Pydantic schema for the LLM-produced investigation report.

The LLM is instructed to emit a strict enum, but real-world fine-tunes can
drift to common synonyms ("FRAUD" instead of "FRAUD_CONFIRMED", "REVIEW"
instead of "MANUAL_REVIEW"). To avoid a poison-message loop where the
consumer rejects every message from such a model, we normalize before
validation. Genuinely unrecognised values still fail validation and route
to the LLM-failure fallback path.
"""

from typing import Any, List, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

Verdict = Literal["FRAUD_CONFIRMED", "LIKELY_LEGITIMATE", "UNCERTAIN"]
RecommendedAction = Literal["BLOCK", "CONTACT_CUSTOMER", "MANUAL_REVIEW", "RELEASE"]


_VERDICT_SYNONYMS = {
    "FRAUD": "FRAUD_CONFIRMED",
    "FRAUDULENT": "FRAUD_CONFIRMED",
    "CONFIRMED_FRAUD": "FRAUD_CONFIRMED",
    "LEGITIMATE": "LIKELY_LEGITIMATE",
    "LEGIT": "LIKELY_LEGITIMATE",
    "GENUINE": "LIKELY_LEGITIMATE",
    "UNKNOWN": "UNCERTAIN",
    "UNSURE": "UNCERTAIN",
    "UNDETERMINED": "UNCERTAIN",
}

_ACTION_SYNONYMS = {
    "DECLINE": "BLOCK",
    "REJECT": "BLOCK",
    "REVIEW": "MANUAL_REVIEW",
    "ESCALATE": "MANUAL_REVIEW",
    "CONTACT": "CONTACT_CUSTOMER",
    "CALL_CUSTOMER": "CONTACT_CUSTOMER",
    "CALL": "CONTACT_CUSTOMER",
    "ACCEPT": "RELEASE",
    "APPROVE": "RELEASE",
    "ALLOW": "RELEASE",
}


def _normalize(value: Any, synonyms: dict) -> Any:
    if not isinstance(value, str):
        return value
    key = value.strip().upper().replace("-", "_").replace(" ", "_")
    return synonyms.get(key, key)


class InvestigationReport(BaseModel):
    verdict: Verdict
    agent_confidence: float = Field(ge=0.0, le=1.0)
    recommended_action: RecommendedAction
    key_indicators: List[str] = Field(min_length=1, max_length=10)
    narrative: str = Field(min_length=10, max_length=4000)

    @model_validator(mode="before")
    @classmethod
    def _normalize_enums(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if "verdict" in data:
                data["verdict"] = _normalize(data["verdict"], _VERDICT_SYNONYMS)
            if "recommended_action" in data:
                data["recommended_action"] = _normalize(data["recommended_action"], _ACTION_SYNONYMS)
        return data

    @field_validator("key_indicators")
    @classmethod
    def _trim_indicators(cls, v: List[str]) -> List[str]:
        cleaned = [s.strip() for s in v if s and s.strip()]
        if not cleaned:
            raise ValueError("key_indicators must contain at least one non-empty string")
        return cleaned


__all__ = ["InvestigationReport", "ValidationError", "Verdict", "RecommendedAction"]
