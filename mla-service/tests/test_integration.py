"""
Integration tests for MLA service.
"""

import pytest
import numpy as np
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestIntegration:
    """Integration tests for the full pipeline."""
    
    def test_full_training_pipeline(self):
        """Test full training pipeline without external services."""
        from src.training.preprocessor import DataPreprocessor
        from src.training.trainer import ModelTrainer
        from src.training.validator import ModelValidator
        from src.deployment.onnx_converter import ONNXConverter
        import pandas as pd
        
        # Mock config
        class MockConfig:
            XGBOOST_N_ESTIMATORS = 10
            XGBOOST_MAX_DEPTH = 3
            XGBOOST_LEARNING_RATE = 0.1
            XGBOOST_SUBSAMPLE = 0.8
            XGBOOST_COLSAMPLE_BYTREE = 0.8
            CV_FOLDS = 2
        
        config = MockConfig()
        
        # Generate synthetic data
        np.random.seed(42)
        n_samples = 500
        n_features = 434
        
        X = pd.DataFrame(np.random.rand(n_samples, n_features).astype(np.float32))
        y = pd.Series(np.concatenate([np.zeros(450), np.ones(50)]).astype(int))
        
        # Preprocess
        preprocessor = DataPreprocessor()
        X_train, X_val, X_test, y_train, y_val, y_test = preprocessor.preprocess(X, y)
        
        assert X_train.shape[1] == n_features
        
        # Train
        trainer = ModelTrainer(config)
        model, metrics = trainer.train(X_train, y_train, X_val, y_val)
        
        assert metrics['f1_score'] > 0
        assert metrics['auc_roc'] > 0.5
        
        # Validate
        validator = ModelValidator()
        # Compare model to itself (baseline test)
        result = validator.ab_test(model, model, X_test, y_test)
        
        assert 'decision' in result
        
        # Convert to ONNX
        converter = ONNXConverter()
        
        with tempfile.TemporaryDirectory() as tmpdir:
            model_path = os.path.join(tmpdir, 'test_model.onnx')
            
            converter.convert_to_onnx(
                model=model,
                scaler=preprocessor.get_scaler(),
                output_path=model_path,
                num_features=n_features
            )
            
            assert os.path.exists(model_path)
            assert os.path.exists(model_path.replace('.onnx', '_scaler.npz'))
            
            # Verify model can do inference
            predictions = converter.load_and_predict(
                model_path=model_path,
                features=X_test[:5],
                scaler_path=model_path.replace('.onnx', '_scaler.npz')
            )
            
            assert len(predictions) == 5
            assert all(0 <= p <= 1 for p in predictions)
    
    def test_drift_detection_to_training(self):
        """Test drift detection triggering training."""
        from src.monitoring.drift_detector import DriftDetector
        import pandas as pd
        from src.training.preprocessor import DataPreprocessor
        from src.training.trainer import ModelTrainer
        
        class MockConfig:
            XGBOOST_N_ESTIMATORS = 5
            XGBOOST_MAX_DEPTH = 2
            XGBOOST_LEARNING_RATE = 0.1
            XGBOOST_SUBSAMPLE = 0.8
            XGBOOST_COLSAMPLE_BYTREE = 0.8
            CV_FOLDS = 2
        
        config = MockConfig()
        
        # Create drift detector
        detector = DriftDetector(
            window_size=100,
            f1_threshold=0.95,  # High threshold to trigger drift
            psi_threshold=0.25
        )
        
        # Simulate poor predictions to trigger drift
        np.random.seed(42)
        for i in range(150):
            actual = np.random.randint(0, 2)
            # Random predictions = poor F1
            prediction = np.random.randint(0, 2)
            detector.update(
                prediction=prediction,
                actual=actual,
                probability=np.random.random(),
                features={'amount': np.random.lognormal(8, 1)}
            )
        
        # Check for drift
        drift_detected, metrics = detector.check_drift()
        
        # With random predictions, F1 should be low
        assert metrics['f1_score'] < 0.95
        
        # If drift detected, trigger training
        if drift_detected:
            # Generate training data
            n_samples = 200
            X = pd.DataFrame(np.random.rand(n_samples, 20).astype(np.float32))
            y = pd.Series(np.random.randint(0, 2, n_samples))
            
            # Preprocess and train
            preprocessor = DataPreprocessor()
            X_train, X_val, X_test, y_train, y_val, y_test = preprocessor.preprocess(X, y)
            
            trainer = ModelTrainer(config)
            model, training_metrics = trainer.train(X_train, y_train, X_val, y_val)
            
            assert model is not None
            assert training_metrics['f1_score'] > 0
            
            # Reset drift detector after retraining
            detector.reset()
            assert len(detector.predictions) == 0
    
    def test_model_versioning(self):
        """Test model version incrementing."""
        # Test version parsing and incrementing
        versions = [
            ("v1.0", "v1.1"),
            ("v1.5", "v1.6"),
            ("v2.0", "v2.1"),
        ]
        
        for current, expected_next in versions:
            version_parts = current.replace('v', '').split('.')
            major, minor = int(version_parts[0]), int(version_parts[1])
            next_version = f"v{major}.{minor + 1}"
            
            assert next_version == expected_next


class TestEnvironmentConfig:
    """Test environment configuration."""
    
    def test_config_loads(self):
        """Test that config loads without error."""
        # Set required env vars for testing
        os.environ.setdefault('POSTGRES_HOST', 'localhost')
        os.environ.setdefault('POSTGRES_PORT', '5433')
        os.environ.setdefault('POSTGRES_DB', 'fraud_db')
        os.environ.setdefault('POSTGRES_USER', 'postgres')
        os.environ.setdefault('POSTGRES_PASSWORD', 'postgres')
        
        from src.config import config
        
        assert config.POSTGRES_HOST == 'localhost'
        assert config.TRAINING_DATA_SIZE == 50000
        assert config.DRIFT_F1_THRESHOLD == 0.92
    
    def test_config_validation(self):
        """Test config validation."""
        from src.config import Config
        
        # Valid config should pass
        assert Config.validate() == True


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
