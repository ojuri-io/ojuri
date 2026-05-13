"""
Configuration management for FIA service.
Mirrors the convention used by mla-service: env-driven, fail-fast on validation.
"""

import os
from typing import List, Optional

from dotenv import load_dotenv

load_dotenv()


class Config:
    """FIA Service Configuration."""

    # ───────── Kafka ─────────
    KAFKA_BROKERS: List[str] = os.getenv("KAFKA_BROKERS", "localhost:9092").split(",")
    KAFKA_BLOCKED_TOPIC: str = os.getenv("KAFKA_BLOCKED_TOPIC", "transactions.blocked")
    KAFKA_CONSUMER_GROUP: str = os.getenv("KAFKA_CONSUMER_GROUP", "fraud-investigation")
    KAFKA_AUTO_OFFSET_RESET: str = os.getenv("KAFKA_AUTO_OFFSET_RESET", "earliest")

    # ───────── PostgreSQL ─────────
    POSTGRES_HOST: str = os.getenv("POSTGRES_HOST", "localhost")
    POSTGRES_PORT: int = int(os.getenv("POSTGRES_PORT", "5433"))
    POSTGRES_DB: str = os.getenv("POSTGRES_DB", "fraud_db")
    POSTGRES_USER: str = os.getenv("POSTGRES_USER", "postgres")
    POSTGRES_PASSWORD: str = os.getenv("POSTGRES_PASSWORD", "postgres")

    # ───────── LLM ─────────
    LLM_MODEL_NAME: str = os.getenv("LLM_MODEL_NAME", "microsoft/Phi-3-mini-4k-instruct")
    # Optional path to a fine-tuned local checkpoint. If set, used instead of MODEL_NAME.
    LLM_MODEL_PATH: Optional[str] = os.getenv("LLM_MODEL_PATH") or None
    LLM_DEVICE: str = os.getenv("LLM_DEVICE", "auto")
    LLM_DTYPE: str = os.getenv("LLM_DTYPE", "auto")
    LLM_MAX_NEW_TOKENS: int = int(os.getenv("LLM_MAX_NEW_TOKENS", "384"))
    LLM_TEMPERATURE: float = float(os.getenv("LLM_TEMPERATURE", "0.2"))

    # ───────── Reporting ─────────
    PROMPT_TEMPLATE_VERSION: str = os.getenv("PROMPT_TEMPLATE_VERSION", "v1")
    FALLBACK_ON_LLM_FAILURE: bool = (
        os.getenv("FIA_FALLBACK_ON_LLM_FAILURE", "true").lower() == "true"
    )

    # ───────── Operational ─────────
    METRICS_PORT: int = int(os.getenv("METRICS_PORT", "9094"))
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")

    @classmethod
    def validate(cls) -> bool:
        errors = []
        if cls.LLM_MAX_NEW_TOKENS <= 0:
            errors.append("LLM_MAX_NEW_TOKENS must be positive")
        if not 0 <= cls.LLM_TEMPERATURE <= 2:
            errors.append("LLM_TEMPERATURE must be between 0 and 2")
        if not cls.KAFKA_BLOCKED_TOPIC:
            errors.append("KAFKA_BLOCKED_TOPIC must be set")
        if errors:
            raise ValueError("Configuration validation failed:\n" + "\n".join(errors))
        return True


config = Config()
config.validate()
