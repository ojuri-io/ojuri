# Model Learning Agent (MLA) Service

A Python-based automated model retraining service for fraud detection. This service monitors the fraud detection model's performance and automatically retrains when concept drift is detected.

## Features

- **Drift Detection**: Monitors F1-score and PSI (Population Stability Index) to detect concept drift
- **Automated Retraining**: XGBoost model with SMOTE for class imbalancing
- **A/B Testing**: McNemar's statistical test for model comparison
- **ONNX Conversion**: Converts models to ONNX format for RDA service inference
- **Model Registry**: Filesystem-backed. Versions land in `models/versions/<v>/` (shared with RDA via bind-mount) and are registered with RDA over `POST /v1/admin/models`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      MLA Service                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Kafka     │───►│    Drift     │───►│   Training   │       │
│  │  Consumer   │    │  Detector    │    │   Pipeline   │       │
│  └─────────────┘    └──────────────┘    └──────────────┘       │
│        │                   │                   │                │
│        ▼                   ▼                   ▼                │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │  PostgreSQL │    │  F1 + PSI    │    │    ONNX      │       │
│  │  (labels)   │    │  Monitoring  │    │  Converter   │       │
│  └─────────────┘    └──────────────┘    └──────────────┘       │
│                                                │                │
│                                                ▼                │
│                                         ┌──────────────┐       │
│                                         │ Filesystem   │       │
│                                         │   Registry   │       │
│                                         │ models/      │       │
│                                         │ versions/    │       │
│                                         └──────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.11+
- PostgreSQL database with transactions table
- Kafka for event streaming
- Shared `models/` directory bind-mounted between RDA and MLA (registry artefacts)

### Installation

```bash
# Clone and navigate to MLA service
cd mla-service

# Create virtual environment
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Copy environment configuration
cp .env.example .env
# Edit .env with your settings
```

> **Note**: The requirements.txt uses pinned ONNX versions for XGBoost compatibility. See [ONNX Compatibility](#onnx-compatibility) section below.

### Train Initial Model

```bash
# Train with default settings (50k samples)
python scripts/train_initial_model.py

# Train with custom sample size (for testing)
python scripts/train_initial_model.py --samples 10000

# Skip filesystem registry materialisation (raw ONNX only)
python scripts/train_initial_model.py --skip-registry
```

**Output files:**
- `models/fraud_model_v1.0.onnx` - ONNX model for RDA inference
- `models/fraud_model_v1.0.json` - XGBoost native format (backup)
- `models/scaler_v1.0.npz` - StandardScaler parameters

**Deploy to RDA:**
```bash
cp models/fraud_model_v1.0.onnx ../models/fraud_model.onnx
```

### Training Data Requirements

The training script loads data from PostgreSQL's `transactions` table:

| Requirement | Details |
|-------------|---------|
| **Labeled data** | `fraudLabel` column must be `true` or `false` (not `NULL`) |
| **Both classes** | Need fraud AND non-fraud examples |
| **Minimum samples** | ~100 for testing, ~10,000 for reasonable accuracy |

**If no labeled data exists**, the script generates synthetic data for development.

**Add test labels manually:**
```sql
-- Mark some transactions as fraud for testing
UPDATE transactions SET "fraudLabel" = true WHERE amount > 50000;
UPDATE transactions SET "fraudLabel" = false WHERE amount <= 50000 AND "fraudLabel" IS NULL;
```

### Common Training Warnings

| Warning | Meaning | Solution |
|---------|---------|----------|
| `Fraud rate: 0.00%` | No fraud examples in training data | Add fraud-labeled transactions |
| `Expected shape {-1,2} got {1,1}` | Single-class model (no fraud class) | Train with both fraud/non-fraud |
| `PROTOTYPE MODE: USING PLACEHOLDER FEATURES` | Expected - using simplified features | Extend feature engineering before production |

### Start Monitoring Service

```bash
# Start the MLA service
python -m src.main

# Or force training first
python -m src.main --train
```

### Docker Deployment

```bash
# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f mla-service
```

## Configuration

Key environment variables (see `.env.example` for all options):

| Variable | Default | Description |
|----------|---------|-------------|
| `TRAINING_DATA_SIZE` | 50000 | Number of samples for training |
| `DRIFT_F1_THRESHOLD` | 0.92 | Retrain if F1 drops below this |
| `DRIFT_PSI_THRESHOLD` | 0.25 | Retrain if PSI exceeds this |
| `DRIFT_WINDOW_SIZE` | 1000 | Sliding window for monitoring |

### Recommended Settings by Environment

| Environment | `TRAINING_DATA_SIZE` | RAM Required |
|-------------|---------------------|--------------|
| Development | 10,000 | ~2 GB |
| Staging | 50,000 | ~4 GB |
| Production | 500,000+ | ~16 GB |

## Project Structure

```
mla-service/
├── src/
│   ├── config.py            # Configuration management
│   ├── main.py              # Main orchestration
│   ├── consumer/
│   │   └── kafka_consumer.py # Kafka event consumer
│   ├── deployment/
│   │   ├── model_registry.py # Filesystem registry + RDA admin bridge
│   │   └── onnx_converter.py # XGBoost → ONNX
│   ├── monitoring/
│   │   └── drift_detector.py # F1 + PSI monitoring
│   ├── training/
│   │   ├── data_loader.py   # PostgreSQL data loading
│   │   ├── preprocessor.py  # SMOTE + scaling
│   │   ├── trainer.py       # XGBoost training
│   │   └── validator.py     # A/B testing
│   └── utils/
│       ├── database.py      # PostgreSQL connections
│       └── logger.py        # Structured logging
├── scripts/
│   └── train_initial_model.py  # Cold start training
├── tests/
│   ├── test_drift_detection.py
│   ├── test_onnx_conversion.py
│   ├── test_training.py
│   └── test_integration.py
├── models/                  # Local model storage
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
└── README.md
```

## Testing

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=src --cov-report=html

# Run specific test
pytest tests/test_onnx_conversion.py -v
```

## Drift Detection

The service monitors for concept drift using two metrics:

1. **F1-Score Drop**: If the sliding window F1-score drops below `DRIFT_F1_THRESHOLD`, retraining is triggered.

2. **PSI (Population Stability Index)**: If PSI exceeds `DRIFT_PSI_THRESHOLD`, indicating feature distribution shift, retraining is triggered.

PSI buckets are calculated on the `amount` feature by default.

## A/B Testing

When a new model is trained, it's compared against the current model using:

1. **Performance Metrics**: F1-score, precision, recall, AUC-ROC
2. **McNemar's Test**: Statistical significance of prediction differences
3. **Deployment Decision**: Deploy only if improvement is statistically significant

## ONNX Conversion

Models are converted to ONNX format for compatibility with the RDA (Real-time Data Analyzer) service:

- **Input**: XGBoost classifier + StandardScaler
- **Output**: `.onnx` model file + `_scaler.npz` parameters
- **Validation**: Automatic inference test with ONNX Runtime

### ONNX Compatibility

XGBoost → ONNX conversion requires specific library versions due to a type mismatch bug in newer releases.

**Working versions (pinned in requirements.txt):**
```
onnx==1.13.0
onnxmltools==1.10.0
onnxconverter-common==1.12.0
```

**Bug**: `onnxmltools >= 1.11.0` with `onnx >= 1.14.0` causes:
```
TypeError: Field onnx.AttributeProto.ints: Expected an int, got a boolean.
```

**If you encounter this error**, reinstall the pinned versions:
```bash
pip install onnx==1.13.0 onnxmltools==1.10.0 onnxconverter-common==1.12.0
```

## Design Notes

Key considerations adopters should be aware of:

- **Fraud Label Delay**: Real fraud labels arrive 3-7 days after transaction (via chargebacks). The drift detector and retraining cadence are designed around this delayed-feedback constraint.
- **Catalogue-Driven Features**: The base catalogue (`models/feature-catalog.v1.json`) defines 64 features in 9 categories. Adopters extend this via `feature-catalog.adopter.json` overlay using declarative compute ops — no Python or TS code changes required. See `docs/FEATURES.md`.
- **SMOTE**: Critical for handling severe class imbalance in fraud data (~0.1% fraud rate). Applied on the training split only — never on validation/test.
- **Synthetic Data Fallback**: When no labeled data exists, synthetic data is generated. This is fine for development and integration tests; production requires real fraud/non-fraud labels.
- **ONNX Library Pinning**: `onnx==1.13.0` / `onnxmltools==1.10.0` are deliberately pinned — newer versions break XGBoost-to-ONNX conversion with a `Field onnx.AttributeProto.ints` type mismatch.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `No labeled transactions found` | Add `fraudLabel` values to transactions table |
| `ONNX conversion failed` | Check library versions match requirements.txt |
| `ModuleNotFoundError` | Ensure venv is activated: `source venv/bin/activate` |
| `Connection refused (PostgreSQL)` | Start database: `docker compose up -d postgres` |
| `Shape mismatch warning` | Train with both fraud and non-fraud labels |

## License

MIT License — see [`LICENSE`](../LICENSE) at the repository root.
