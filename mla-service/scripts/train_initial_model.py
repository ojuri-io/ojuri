#!/usr/bin/env python3
"""
Script to train the initial fraud detection model.
Run this for cold start when no model exists.

Usage:
    python scripts/train_initial_model.py
    python scripts/train_initial_model.py --samples 10000
"""

import argparse
import os
import sys

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.config import config, Config
from src.utils.logger import get_logger
from src.training.data_loader import DataLoader
from src.training.preprocessor import DataPreprocessor
from src.training.trainer import ModelTrainer
from src.deployment.onnx_converter import ONNXConverter
from src.deployment.model_registry import ModelRegistry


logger = get_logger(__name__)


def train_initial_model(num_samples: int = None, skip_registry: bool = False):
    """
    Train initial fraud detection model.

    Args:
        num_samples: Number of training samples (overrides config)
        skip_registry: Skip materialising into ``models/versions/`` and
            registering with RDA (useful for local sanity checks where
            you only want the raw ONNX artefact).
    """
    logger.info("=" * 60)
    logger.info("MLA INITIAL MODEL TRAINING")
    logger.info("=" * 60)
    
    # Override training size if specified
    if num_samples:
        config.TRAINING_DATA_SIZE = num_samples
        logger.info(f"Using custom training size: {num_samples}")
    
    # Validate configuration
    if not Config.validate():
        logger.error("Configuration validation failed")
        sys.exit(1)
    
    # Create output directory
    output_dir = config.MODEL_OUTPUT_DIR
    os.makedirs(output_dir, exist_ok=True)
    
    # Step 1: Load training data
    logger.info("")
    logger.info("[1/5] Loading training data...")
    data_loader = DataLoader()
    X, y = data_loader.load_training_data(limit=config.TRAINING_DATA_SIZE)
    
    if X is None or len(X) == 0:
        logger.error("Failed to load training data")
        sys.exit(1)
    
    logger.info(f"  Loaded {len(X)} samples with {X.shape[1]} features")
    logger.info(f"  Fraud rate: {y.mean() * 100:.2f}%")
    
    # Step 2: Preprocess data
    logger.info("")
    logger.info("[2/5] Preprocessing data...")
    preprocessor = DataPreprocessor()
    X_train, X_val, X_test, y_train, y_val, y_test = preprocessor.preprocess(X, y)
    
    logger.info(f"  Training set: {len(X_train)} samples (fraud rate: {y_train.mean() * 100:.1f}%)")
    logger.info(f"  Validation set: {len(X_val)} samples")
    logger.info(f"  Test set: {len(X_test)} samples")
    
    # Step 3: Train model
    logger.info("")
    logger.info("[3/5] Training XGBoost model...")
    trainer = ModelTrainer(config)
    model, calibrator, metrics = trainer.train(X_train, y_train, X_val, y_val)
    
    logger.info(f"  Training complete!")
    logger.info(f"  F1-Score: {metrics['f1_score']:.4f}")
    logger.info(f"  AUC-ROC:  {metrics['auc_roc']:.4f}")
    logger.info(f"  Precision: {metrics['precision']:.4f}")
    logger.info(f"  Recall:   {metrics['recall']:.4f}")
    
    # Get feature importance
    importance = trainer.get_feature_importance(model, top_n=10)
    if importance:
        logger.info("")
        logger.info("  Top 10 Features:")
        for name, score in list(importance.items())[:10]:
            logger.info(f"    {name}: {score:.4f}")
    
    # Step 4: Convert to ONNX
    logger.info("")
    logger.info("[4/5] Converting to ONNX format...")
    converter = ONNXConverter()
    
    model_path = os.path.join(output_dir, 'fraud_model_v1.0.onnx')
    scaler = preprocessor.get_scaler()
    
    onnx_path = converter.convert_to_onnx(
        model=model,
        scaler=scaler,
        output_path=model_path,
        num_features=X_train.shape[1]
    )
    
    if onnx_path:
        model_info = converter.get_model_info(onnx_path)
        logger.info(f"  ONNX model saved: {onnx_path}")
        logger.info(f"  Size: {model_info.get('size_mb', 0):.2f} MB")

    if calibrator is not None and calibrator.fitted:
        calibrator_path = os.path.join(output_dir, 'fraud_model_v1.0_calibrator.npz')
        calibrator.save(calibrator_path)
        metrics['calibrator_path'] = calibrator_path
        logger.info(f"  Calibrator saved: {calibrator_path}")
        if 'brier_score' in metrics and 'brier_score_uncalibrated' in metrics:
            logger.info(
                "  Brier score: %.4f (uncalibrated %.4f)",
                metrics['brier_score'],
                metrics['brier_score_uncalibrated'],
            )
    
    # Step 5: Materialise into the filesystem registry (optional).
    # Writes models/versions/v1.0/{model.onnx,model.pkl,scaler.npz,meta.json}
    # and, when RDA_API_URL + MLA_SERVICE_TOKEN are set, registers the
    # version with RDA and flips it to ACTIVE so OnnxService hot-reloads.
    logger.info("")
    logger.info("[5/5] Saving to model registry...")

    if skip_registry:
        logger.info("  Skipping registry materialisation (--skip-registry flag)")
    else:
        try:
            registry = ModelRegistry(config)
            version = registry.upload_model(
                model=model,
                model_path=onnx_path,
                version='v1.0',
                metadata={
                    **metrics,
                    'num_features': X_train.shape[1],
                    'training_samples': len(X_train),
                    'is_initial_model': True,
                },
                trigger='initial',
            )
            logger.info(f"  Registered as version: {version}")
        except Exception as e:
            logger.warning(f"  Registry materialisation failed: {e}")
            logger.info("  Raw ONNX still saved at: " + output_dir)
    
    # Summary
    logger.info("")
    logger.info("=" * 60)
    logger.info("TRAINING COMPLETE!")
    logger.info("=" * 60)
    logger.info(f"Model saved to: {output_dir}")
    logger.info("")
    logger.info("Next steps:")
    logger.info("  1. Copy fraud_model_v1.0.onnx to RDA service")
    logger.info("  2. Start MLA service for continuous monitoring")
    logger.info("  3. Monitor drift detection alerts")
    
    return model, metrics


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Train initial fraud detection model'
    )
    parser.add_argument(
        '--samples', '-n',
        type=int,
        default=None,
        help='Number of training samples (default: from config)'
    )
    parser.add_argument(
        '--skip-registry',
        action='store_true',
        help='Skip materialising version into models/versions/ and registering with RDA'
    )
    
    args = parser.parse_args()
    
    train_initial_model(
        num_samples=args.samples,
        skip_registry=args.skip_registry
    )
