"""
Configuration management for MLA service.
Loads from environment variables with sensible defaults.
"""

import os
import sys
import warnings
from pathlib import Path
from dotenv import load_dotenv
from typing import List

# Pin dotenv to `mla-service/.env`. Calling `load_dotenv()` with no args
# walks UP the directory tree looking for a `.env` — which means a
# user running `python -m src.main` from inside `mla-service/` silently
# picks up the repo-root `.env` (intended for RDA). That root file sets
# KAFKA_CONSUMER_GROUP=pattern-analysis (PAA's group), and MLA then
# tries to join an existing kafkajs-based group with a different
# partition-assignment strategy, crashing with
# `kafka.errors.InconsistentGroupProtocolError`.
_SERVICE_ENV = Path(__file__).resolve().parent.parent / ".env"
if _SERVICE_ENV.exists():
    load_dotenv(_SERVICE_ENV, override=False)
else:
    warnings.warn(
        f"No {_SERVICE_ENV} found; MLA will fall back to environment "
        "defaults (model-learning-v2 consumer group, localhost:9092). "
        "Run `cp mla-service/.env.example mla-service/.env` to configure.",
        RuntimeWarning,
        stacklevel=2,
    )


class Config:
    """
    MLA Service Configuration.
    
    All settings loaded from environment variables.
    See .env.example for complete list of options.
    """
    
    # ═══════════════════════════════════════════════════════════════
    # Kafka Configuration
    # ═══════════════════════════════════════════════════════════════
    KAFKA_BROKERS: List[str] = os.getenv('KAFKA_BROKERS', 'localhost:9092').split(',')
    KAFKA_CONSUMER_GROUP: str = os.getenv('KAFKA_CONSUMER_GROUP', 'model-learning-v2')
    KAFKA_TOPIC: str = os.getenv('KAFKA_TOPIC', 'transactions.completed')
    
    # ═══════════════════════════════════════════════════════════════
    # PostgreSQL Configuration
    # ═══════════════════════════════════════════════════════════════
    POSTGRES_HOST: str = os.getenv('POSTGRES_HOST', 'localhost')
    POSTGRES_PORT: int = int(os.getenv('POSTGRES_PORT', '5433'))
    POSTGRES_DB: str = os.getenv('POSTGRES_DB', 'fraud_db')
    POSTGRES_USER: str = os.getenv('POSTGRES_USER', 'postgres')
    POSTGRES_PASSWORD: str = os.getenv('POSTGRES_PASSWORD', 'postgres')
    
    # ═══════════════════════════════════════════════════════════════
    # Drift Detection Thresholds
    # ═══════════════════════════════════════════════════════════════
    DRIFT_F1_THRESHOLD: float = float(os.getenv('DRIFT_F1_THRESHOLD', '0.92'))
    DRIFT_PSI_THRESHOLD: float = float(os.getenv('DRIFT_PSI_THRESHOLD', '0.25'))
    DRIFT_WINDOW_SIZE: int = int(os.getenv('DRIFT_WINDOW_SIZE', '1000'))
    
    # ═══════════════════════════════════════════════════════════════
    # Training Configuration
    # ═══════════════════════════════════════════════════════════════
    # UPDATED: Changed from 500000 to 50000 for laptop compatibility
    # 50k samples: ~5 min training, ~1GB RAM (laptop-friendly)
    # 500k samples: ~60 min training, ~10GB RAM (production)
    TRAINING_DATA_SIZE: int = int(os.getenv('TRAINING_DATA_SIZE', '50000'))
    SMOTE_RATIO: float = float(os.getenv('SMOTE_RATIO', '1.0'))
    CV_FOLDS: int = int(os.getenv('CV_FOLDS', '5'))
    # Absolute F1 floor for auto-activation. A candidate below this is
    # registered as CANDIDATE (operator review) even when it beats the
    # incumbent — guards against garbage-in/garbage-out cold starts.
    MIN_DEPLOY_F1: float = float(os.getenv('MIN_DEPLOY_F1', '0.3'))
    
    # ═══════════════════════════════════════════════════════════════
    # XGBoost Hyperparameters
    # ═══════════════════════════════════════════════════════════════
    XGBOOST_N_ESTIMATORS: int = int(os.getenv('XGBOOST_N_ESTIMATORS', '150'))
    XGBOOST_MAX_DEPTH: int = int(os.getenv('XGBOOST_MAX_DEPTH', '6'))
    XGBOOST_LEARNING_RATE: float = float(os.getenv('XGBOOST_LEARNING_RATE', '0.1'))
    XGBOOST_SUBSAMPLE: float = float(os.getenv('XGBOOST_SUBSAMPLE', '0.8'))
    XGBOOST_COLSAMPLE_BYTREE: float = float(os.getenv('XGBOOST_COLSAMPLE_BYTREE', '0.8'))
    
    # ═══════════════════════════════════════════════════════════════
    # Model Registry — filesystem-backed
    # ═══════════════════════════════════════════════════════════════
    # MinIO retired from the self-hosted distribution. The flow is now:
    #   1. MLA writes `models/versions/<version>/` directly.
    #   2. MLA POSTs to RDA admin to register + activate (optional).
    #   3. RDA's OnnxService hot-reloads the new ACTIVE on disk.
    #
    # `RDA_API_URL` + `MLA_SERVICE_TOKEN` are optional. When unset,
    # MLA writes locally and operators activate via the admin UI.
    RDA_API_URL: str = os.getenv('RDA_API_URL', '')
    MLA_SERVICE_TOKEN: str = os.getenv('MLA_SERVICE_TOKEN', '')

    # ═══════════════════════════════════════════════════════════════
    # Paths
    # ═══════════════════════════════════════════════════════════════
    # Default points at the repo-root `models/` directory so MLA
    # writes land where RDA reads from (bind-mounted into the RDA
    # container as `/app/models`).
    MODEL_OUTPUT_DIR: str = os.getenv('MODEL_OUTPUT_DIR', '../models')
    DATA_CACHE_DIR: str = os.getenv('DATA_CACHE_DIR', './data')
    
    # ═══════════════════════════════════════════════════════════════
    # Health / metrics HTTP server
    # ═══════════════════════════════════════════════════════════════
    METRICS_PORT: int = int(os.getenv('METRICS_PORT', '9095'))

    # ═══════════════════════════════════════════════════════════════
    # Logging
    # ═══════════════════════════════════════════════════════════════
    LOG_LEVEL: str = os.getenv('LOG_LEVEL', 'INFO')
    
    @classmethod
    def validate(cls):
        """Validate configuration values."""
        errors = []
        
        # Validate thresholds
        if not 0 < cls.DRIFT_F1_THRESHOLD <= 1:
            errors.append(f"DRIFT_F1_THRESHOLD must be between 0 and 1, got {cls.DRIFT_F1_THRESHOLD}")
        
        if not 0 < cls.DRIFT_PSI_THRESHOLD < 1:
            errors.append(f"DRIFT_PSI_THRESHOLD must be between 0 and 1, got {cls.DRIFT_PSI_THRESHOLD}")
        
        if cls.TRAINING_DATA_SIZE <= 0:
            errors.append(f"TRAINING_DATA_SIZE must be positive, got {cls.TRAINING_DATA_SIZE}")
        
        if errors:
            raise ValueError(f"Configuration validation failed:\n" + "\n".join(errors))
        
        return True


# Create global config instance
config = Config()

# Validate on import
config.validate()
