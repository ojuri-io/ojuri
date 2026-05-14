#!/usr/bin/env python3
"""
Train Fraud Detection Model with Real Datasets.

Training pipeline:

1. IEEE-CIS Fraud Detection dataset (590,540 transactions, 434 features)
   - Credit card transactions from IEEE Computational Intelligence Society, 2019
   - Fraud prevalence: ~3.5%

2. PaySim synthetic mobile money data (50,000 transactions)
   - Modeling CASH_IN, CASH_OUT, DEBIT, PAYMENT, TRANSFER
   - From Lopez-Rojas et al., 2016
   - Fraud prevalence: ~0.30%

3. SMOTE for class imbalance handling (Chawla et al., 2002)
   - Training set balanced to 50-50 fraud-legitimate
   - Test set maintains natural distribution for realistic evaluation

Usage:
    # Full training with both datasets
    python scripts/train_with_datasets.py

    # IEEE-CIS only
    python scripts/train_with_datasets.py --ieee-only

    # Limited samples for quick testing
    python scripts/train_with_datasets.py --ieee-samples 100000 --paysim-samples 10000

    # Skip model registry upload
    python scripts/train_with_datasets.py --skip-registry
"""

import argparse
import os
import sys
import time
import pickle
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.config import config, Config
from src.utils.logger import get_logger
from src.training.dataset_loader import DatasetLoader, check_dataset_availability
from src.training.preprocessor import DataPreprocessor
from src.training.trainer import ModelTrainer
from src.deployment.onnx_converter import ONNXConverter
from src.deployment.model_registry import ModelRegistry

logger = get_logger(__name__)


def print_methodology():
    """Print training methodology summary."""
    logger.info("=" * 70)
    logger.info("FRAUD DETECTION MODEL TRAINING")
    logger.info("=" * 70)
    logger.info("")
    logger.info("DATASETS:")
    logger.info("  • IEEE-CIS Fraud Detection (IEEE CIS, 2019)")
    logger.info("    - 590,540 credit card transactions")
    logger.info("    - 434 engineered features")
    logger.info("    - ~3.5% fraud rate")
    logger.info("")
    logger.info("  • PaySim Mobile Money (Lopez-Rojas et al., 2016)")
    logger.info("    - 50,000 transaction subset")
    logger.info("    - 5 types: CASH_IN, CASH_OUT, DEBIT, PAYMENT, TRANSFER")
    logger.info("    - ~0.30% fraud rate")
    logger.info("")
    logger.info("CLASS IMBALANCE HANDLING:")
    logger.info("  • SMOTE oversampling (Chawla et al., 2002)")
    logger.info("  • Training set: 50-50 balanced")
    logger.info("  • Test set: Natural distribution preserved")
    logger.info("")
    logger.info("MODEL:")
    logger.info("  • XGBoost gradient boosting")
    logger.info("  • ONNX export for production inference")
    logger.info("=" * 70)
    logger.info("")


def check_datasets():
    """Check dataset availability and provide instructions if missing."""
    availability = check_dataset_availability()
    
    logger.info("Dataset Availability Check:")
    
    all_available = True
    if availability['ieee_cis_transaction']:
        logger.info("  ✓ IEEE-CIS train_transaction.csv")
    else:
        logger.warning("  ✗ IEEE-CIS train_transaction.csv NOT FOUND")
        all_available = False
    
    if availability['ieee_cis_identity']:
        logger.info("  ✓ IEEE-CIS train_identity.csv")
    else:
        logger.warning("  ✗ IEEE-CIS train_identity.csv NOT FOUND (optional)")
    
    if availability['paysim']:
        logger.info("  ✓ PaySim dataset")
    else:
        logger.warning("  ✗ PaySim dataset NOT FOUND")
        all_available = False
    
    if not all_available:
        logger.warning("")
        logger.warning("Some datasets are missing!")
        logger.warning("Download them by running:")
        logger.warning("  python scripts/download_datasets.py")
        logger.warning("")
        logger.warning("Or manually download from:")
        logger.warning("  - IEEE-CIS: https://www.kaggle.com/c/ieee-fraud-detection/data")
        logger.warning("  - PaySim: https://www.kaggle.com/datasets/ealaxi/paysim1")
        logger.warning("")
    
    return all_available


def train_with_real_datasets(
    ieee_samples: int = None,
    paysim_samples: int = 50000,
    ieee_only: bool = False,
    paysim_only: bool = False,
    synthetic_only: bool = False,
    synthetic_samples: int = None,
    skip_registry: bool = False
):
    """
    Train model using real datasets.
    
    Args:
        ieee_samples: Max IEEE-CIS samples (None for all)
        paysim_samples: Max PaySim samples
        ieee_only: Use only IEEE-CIS dataset
        paysim_only: Use only PaySim dataset
        synthetic_only: Use only synthetic dataset
        synthetic_samples: Max synthetic samples
        skip_registry: Skip writing into the filesystem model registry
    """
    start_time = time.time()
    
    print_methodology()
    
    # Validate configuration
    if not Config.validate():
        logger.error("Configuration validation failed")
        sys.exit(1)
    
    # Check datasets
    if not check_datasets():
        logger.warning("Continuing with available datasets...")
    
    # Create output directory
    output_dir = Path(config.MODEL_OUTPUT_DIR)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # ═══════════════════════════════════════════════════════════════
    # STEP 1: Load Datasets
    # ═══════════════════════════════════════════════════════════════
    logger.info("")
    logger.info("[1/5] Loading Training Datasets...")
    logger.info("-" * 50)
    
    loader = DatasetLoader()
    
    if synthetic_only:
        logger.info("Loading synthetic dataset...")
        X, y = loader.load_synthetic(max_samples=synthetic_samples)
    elif ieee_only:
        logger.info("Loading IEEE-CIS dataset only...")
        X, y = loader.load_ieee_cis(max_samples=ieee_samples)
    elif paysim_only:
        logger.info("Loading PaySim dataset only...")
        X, y = loader.load_paysim(max_samples=paysim_samples)
    else:
        logger.info("Loading combined datasets (IEEE-CIS + PaySim)...")
        X, y = loader.load_combined_dataset(
            ieee_samples=ieee_samples,
            paysim_samples=paysim_samples,
            combine=True
        )
    
    if X is None or len(X) == 0:
        logger.error("❌ Failed to load datasets!")
        logger.error("Please download datasets first:")
        logger.error("  python scripts/download_datasets.py")
        sys.exit(1)
    
    logger.info("")
    logger.info(f"✓ Loaded {len(X):,} samples with {X.shape[1]} features")
    logger.info(f"  Fraud rate: {y.mean() * 100:.2f}%")
    logger.info(f"  Fraud samples: {y.sum():,}")
    logger.info(f"  Legitimate samples: {(y == 0).sum():,}")
    
    # ═══════════════════════════════════════════════════════════════
    # STEP 2: Preprocess Data with SMOTE
    # ═══════════════════════════════════════════════════════════════
    logger.info("")
    logger.info("[2/5] Preprocessing with SMOTE Balancing...")
    logger.info("-" * 50)
    logger.info("Applying SMOTE (Chawla et al., 2002) for class balance")
    
    preprocessor = DataPreprocessor()
    X_train, X_val, X_test, y_train, y_val, y_test = preprocessor.preprocess(X, y)
    
    logger.info("")
    logger.info("Dataset splits:")
    logger.info(f"  Training:   {len(X_train):,} samples (balanced with SMOTE)")
    logger.info(f"    - Fraud:      {(y_train == 1).sum():,} ({y_train.mean()*100:.1f}%)")
    logger.info(f"    - Legitimate: {(y_train == 0).sum():,} ({(1-y_train.mean())*100:.1f}%)")
    logger.info(f"  Validation: {len(X_val):,} samples (natural distribution)")
    logger.info(f"  Test:       {len(X_test):,} samples (natural distribution)")
    
    # ═══════════════════════════════════════════════════════════════
    # STEP 3: Train XGBoost Model
    # ═══════════════════════════════════════════════════════════════
    logger.info("")
    logger.info("[3/5] Training XGBoost Model...")
    logger.info("-" * 50)
    
    trainer = ModelTrainer(config)
    model, metrics = trainer.train(X_train, y_train, X_val, y_val)
    
    logger.info("")
    logger.info("Training complete!")
    logger.info("Model Performance on Validation Set:")
    logger.info(f"  • F1-Score:  {metrics['f1_score']:.4f}")
    logger.info(f"  • AUC-ROC:   {metrics['auc_roc']:.4f}")
    logger.info(f"  • Precision: {metrics['precision']:.4f}")
    logger.info(f"  • Recall:    {metrics['recall']:.4f}")
    
    # Evaluate on test set
    logger.info("")
    logger.info("Evaluating on Test Set (natural distribution)...")
    test_metrics = trainer.evaluate(model, X_test, y_test)
    
    logger.info("Test Set Performance:")
    logger.info(f"  • F1-Score:  {test_metrics['f1_score']:.4f}")
    logger.info(f"  • AUC-ROC:   {test_metrics['auc_roc']:.4f}")
    logger.info(f"  • Precision: {test_metrics['precision']:.4f}")
    logger.info(f"  • Recall:    {test_metrics['recall']:.4f}")
    
    # Feature importance
    importance = trainer.get_feature_importance(model, top_n=15)
    if importance:
        logger.info("")
        logger.info("Top 15 Most Important Features:")
        for i, (name, score) in enumerate(list(importance.items())[:15], 1):
            logger.info(f"  {i:2d}. {name}: {score:.4f}")
    
    # ═══════════════════════════════════════════════════════════════
    # STEP 4: Export to ONNX
    # ═══════════════════════════════════════════════════════════════
    logger.info("")
    logger.info("[4/5] Converting to ONNX Format...")
    logger.info("-" * 50)
    
    converter = ONNXConverter()
    
    model_version = "1.0"
    model_path = output_dir / f'fraud_model_v{model_version}.onnx'
    scaler = preprocessor.get_scaler()
    
    onnx_path = converter.convert_to_onnx(
        model=model,
        scaler=scaler,
        output_path=str(model_path),
        num_features=X_train.shape[1]
    )
    
    if onnx_path:
        model_info = converter.get_model_info(onnx_path)
        logger.info(f"✓ ONNX model saved: {onnx_path}")
        logger.info(f"  Size: {model_info.get('size_mb', 0):.2f} MB")
    else:
        logger.error("❌ ONNX conversion failed!")
        sys.exit(1)
    
    # ═══════════════════════════════════════════════════════════════
    # STEP 5: Save to Registry
    # ═══════════════════════════════════════════════════════════════
    logger.info("")
    logger.info("[5/5] Saving to Model Registry...")
    logger.info("-" * 50)
    
    # Save XGBoost model locally
    xgb_path = output_dir / f'fraud_model_v{model_version}.pkl'
    with open(xgb_path, 'wb') as f:
        pickle.dump(model, f)
    logger.info(f"  XGBoost model saved: {xgb_path}")
    
    # Save training metadata (convert numpy types to native Python types for JSON serialization)
    def convert_to_serializable(obj):
        """Convert numpy types to JSON-serializable Python types."""
        if isinstance(obj, dict):
            return {k: convert_to_serializable(v) for k, v in obj.items()}
        elif isinstance(obj, (list, tuple)):
            return [convert_to_serializable(item) for item in obj]
        elif hasattr(obj, 'item'):  # numpy scalar
            return obj.item()
        elif hasattr(obj, 'tolist'):  # numpy array
            return obj.tolist()
        else:
            return obj
    
    metadata = {
        'version': model_version,
        'training_samples': int(len(X_train)),
        'test_samples': int(len(X_test)),
        'num_features': int(X_train.shape[1]),
        'datasets': {
            'ieee_cis': loader.ieee_cis_loaded,
            'paysim': loader.paysim_loaded,
            'synthetic': loader.synthetic_loaded
        },
        'smote_applied': True,
        'validation_metrics': convert_to_serializable(metrics),
        'test_metrics': convert_to_serializable(test_metrics),
        'feature_importance': convert_to_serializable(importance)
    }
    
    import json
    metadata_path = output_dir / f'fraud_model_v{model_version}_metadata.json'
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    logger.info(f"  Metadata saved: {metadata_path}")
    
    if skip_registry:
        logger.info("  Skipping filesystem registry (--skip-registry flag)")
    else:
        try:
            registry = ModelRegistry(config)
            version = registry.upload_model(
                model=model,
                model_path=str(onnx_path),
                version=f'v{model_version}',
                metadata=metadata,
            )
            logger.info(f"  ✓ Registered as version: {version}")
        except Exception as e:
            logger.warning(f"  Registry materialisation failed: {e}")
            logger.info("  Raw ONNX still saved locally")
    
    # ═══════════════════════════════════════════════════════════════
    # TRAINING COMPLETE
    # ═══════════════════════════════════════════════════════════════
    elapsed_time = time.time() - start_time
    
    logger.info("")
    logger.info("=" * 70)
    logger.info("TRAINING COMPLETE!")
    logger.info("=" * 70)
    logger.info("")
    logger.info(f"Total training time: {elapsed_time/60:.1f} minutes")
    logger.info("")
    logger.info("Model files saved to:")
    logger.info(f"  • ONNX model: {onnx_path}")
    logger.info(f"  • XGBoost model: {xgb_path}")
    logger.info(f"  • Metadata: {metadata_path}")
    logger.info("")
    logger.info("Performance Summary (Test Set):")
    logger.info(f"  • F1-Score:  {test_metrics['f1_score']:.4f}")
    logger.info(f"  • AUC-ROC:   {test_metrics['auc_roc']:.4f}")
    logger.info(f"  • Precision: {test_metrics['precision']:.4f}")
    logger.info(f"  • Recall:    {test_metrics['recall']:.4f}")
    logger.info("")
    logger.info("Next steps:")
    logger.info("  1. Copy ONNX model to RDA service:")
    logger.info(f"     cp {onnx_path} ../models/fraud_model.onnx")
    logger.info("  2. Restart RDA service to load new model")
    logger.info("  3. Start MLA service for continuous monitoring")
    logger.info("")
    
    return model, metrics, test_metrics


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Train fraud detection model with real datasets',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full training with both datasets
  python scripts/train_with_datasets.py

  # Quick test with limited samples
  python scripts/train_with_datasets.py --ieee-samples 50000 --paysim-samples 10000

  # IEEE-CIS only (credit card fraud)
  python scripts/train_with_datasets.py --ieee-only

  # PaySim only (mobile money fraud)
  python scripts/train_with_datasets.py --paysim-only

  # Synthetic dataset (generated by scripts/generate_synthetic_dataset.py)
  python scripts/train_with_datasets.py --synthetic

  # Skip filesystem registry materialisation
  python scripts/train_with_datasets.py --skip-registry
        """
    )
    
    parser.add_argument(
        '--ieee-samples',
        type=int,
        default=None,
        help='Maximum IEEE-CIS samples (default: all ~590K)'
    )
    
    parser.add_argument(
        '--paysim-samples',
        type=int,
        default=50000,
        help='Maximum PaySim samples (default: 50000)'
    )
    
    parser.add_argument(
        '--synthetic-samples',
        type=int,
        default=None,
        help='Maximum synthetic samples (default: all)'
    )
    
    parser.add_argument(
        '--ieee-only',
        action='store_true',
        help='Use only IEEE-CIS dataset'
    )
    
    parser.add_argument(
        '--paysim-only',
        action='store_true',
        help='Use only PaySim dataset'
    )
    
    parser.add_argument(
        '--synthetic',
        action='store_true',
        help='Use only synthetic dataset (from scripts/generate_synthetic_dataset.py)'
    )
    
    parser.add_argument(
        '--skip-registry',
        action='store_true',
        help='Skip writing the version into the filesystem model registry'
    )
    
    args = parser.parse_args()
    
    exclusive_flags = [args.ieee_only, args.paysim_only, args.synthetic]
    if sum(exclusive_flags) > 1:
        logger.error("Cannot specify multiple --*-only or --synthetic flags")
        sys.exit(1)
    
    train_with_real_datasets(
        ieee_samples=args.ieee_samples,
        paysim_samples=args.paysim_samples,
        ieee_only=args.ieee_only,
        paysim_only=args.paysim_only,
        synthetic_only=args.synthetic,
        synthetic_samples=args.synthetic_samples,
        skip_registry=args.skip_registry
    )
