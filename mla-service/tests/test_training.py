"""
Tests for training functionality.
"""

import pytest
import numpy as np
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.training.preprocessor import DataPreprocessor
from src.training.trainer import ModelTrainer
from src.training.validator import ModelValidator


class TestDataPreprocessor:
    """Test cases for DataPreprocessor."""
    
    def test_initialization(self):
        """Test preprocessor initializes correctly."""
        preprocessor = DataPreprocessor()
        assert preprocessor.smote_ratio == 1.0
        assert not preprocessor._is_fitted
    
    def test_preprocess_basic(self):
        """Test basic preprocessing pipeline."""
        import pandas as pd
        
        preprocessor = DataPreprocessor()
        
        # Create dummy data
        np.random.seed(42)
        n_samples = 200
        X = pd.DataFrame(np.random.rand(n_samples, 20))
        y = pd.Series(np.concatenate([np.zeros(180), np.ones(20)]))  # Imbalanced
        
        # Run preprocessing
        X_train, X_val, X_test, y_train, y_val, y_test = preprocessor.preprocess(X, y)
        
        # Check shapes
        assert len(X_train) > 0
        assert len(X_val) > 0
        assert len(X_test) > 0
        
        # Check types
        assert X_train.dtype == np.float32
        assert y_train.dtype == np.int32
        
        # Check scaler is fitted
        assert preprocessor._is_fitted
    
    def test_smote_balancing(self):
        """Test that SMOTE balances classes."""
        import pandas as pd
        
        preprocessor = DataPreprocessor()
        
        # Create very imbalanced data
        np.random.seed(42)
        n_samples = 500
        X = pd.DataFrame(np.random.rand(n_samples, 20))
        y = pd.Series(np.concatenate([np.zeros(450), np.ones(50)]))  # 10% fraud
        
        X_train, X_val, X_test, y_train, y_val, y_test = preprocessor.preprocess(X, y)
        
        # After SMOTE, training set should be more balanced
        fraud_rate = y_train.mean()
        assert fraud_rate > 0.3  # Much higher than original 10%
    
    def test_get_scaler(self):
        """Test getting fitted scaler."""
        import pandas as pd
        
        preprocessor = DataPreprocessor()
        
        X = pd.DataFrame(np.random.rand(100, 10))
        y = pd.Series(np.random.randint(0, 2, 100))
        
        preprocessor.preprocess(X, y)
        
        scaler = preprocessor.get_scaler()
        assert scaler is not None
        assert hasattr(scaler, 'mean_')
        assert hasattr(scaler, 'scale_')
    
    def test_scaler_params(self):
        """Test getting scaler parameters."""
        import pandas as pd
        
        preprocessor = DataPreprocessor()
        
        X = pd.DataFrame(np.random.rand(100, 10))
        y = pd.Series(np.random.randint(0, 2, 100))
        
        preprocessor.preprocess(X, y)
        
        params = preprocessor.get_scaler_params()
        
        assert 'mean' in params
        assert 'scale' in params
        assert 'var' in params
        assert len(params['mean']) == 10


class TestModelTrainer:
    """Test cases for ModelTrainer."""
    
    @pytest.fixture
    def mock_config(self):
        """Create mock config for testing."""
        class MockConfig:
            XGBOOST_N_ESTIMATORS = 10
            XGBOOST_MAX_DEPTH = 3
            XGBOOST_LEARNING_RATE = 0.1
            XGBOOST_SUBSAMPLE = 0.8
            XGBOOST_COLSAMPLE_BYTREE = 0.8
            CV_FOLDS = 2
        return MockConfig()
    
    def test_initialization(self, mock_config):
        """Test trainer initializes correctly."""
        trainer = ModelTrainer(mock_config)
        
        assert trainer.params['n_estimators'] == 10
        assert trainer.params['max_depth'] == 3
    
    def test_train_basic(self, mock_config):
        """Test basic model training."""
        trainer = ModelTrainer(mock_config)
        
        # Create dummy data
        np.random.seed(42)
        X_train = np.random.rand(200, 20).astype(np.float32)
        y_train = np.random.randint(0, 2, 200).astype(np.int32)
        X_val = np.random.rand(50, 20).astype(np.float32)
        y_val = np.random.randint(0, 2, 50).astype(np.int32)
        
        model, _calibrator, metrics = trainer.train(X_train, y_train, X_val, y_val)
        
        # Check model is trained
        assert model is not None
        assert hasattr(model, 'predict')
        assert hasattr(model, 'predict_proba')
        
        # Check metrics
        assert 'f1_score' in metrics
        assert 'precision' in metrics
        assert 'recall' in metrics
        assert 'auc_roc' in metrics
        assert 'training_time_seconds' in metrics
    
    def test_feature_importance(self, mock_config):
        """Test feature importance extraction."""
        trainer = ModelTrainer(mock_config)
        
        np.random.seed(42)
        X_train = np.random.rand(200, 10).astype(np.float32)
        y_train = np.random.randint(0, 2, 200).astype(np.int32)
        X_val = np.random.rand(50, 10).astype(np.float32)
        y_val = np.random.randint(0, 2, 50).astype(np.int32)
        
        model, _, _ = trainer.train(X_train, y_train, X_val, y_val)
        
        importance = trainer.get_feature_importance(model, top_n=5)
        
        assert len(importance) <= 5
        assert all(isinstance(v, float) for v in importance.values())


class TestModelValidator:
    """Test cases for ModelValidator."""
    
    def test_initialization(self):
        """Test validator initializes correctly."""
        validator = ModelValidator(
            min_improvement=0.01,
            significance_level=0.05
        )
        
        assert validator.min_improvement == 0.01
        assert validator.significance_level == 0.05
    
    def test_ab_test_same_model(self):
        """Test A/B test with same model (should not deploy)."""
        from xgboost import XGBClassifier
        
        validator = ModelValidator(min_improvement=0.01)
        
        # Create and train a single model
        np.random.seed(42)
        X = np.random.rand(200, 20).astype(np.float32)
        y = np.random.randint(0, 2, 200)
        X_test = np.random.rand(100, 20).astype(np.float32)
        y_test = np.random.randint(0, 2, 100)
        
        model = XGBClassifier(n_estimators=10, max_depth=3, random_state=42, use_label_encoder=False)
        model.fit(X, y)
        
        # Compare model to itself
        result = validator.ab_test(model, model, X_test, y_test)
        
        # Same model should have 0 improvement
        assert result['improvements']['f1_score'] == 0.0
        assert result['decision'] == 'KEEP_CURRENT_MODEL'
    
    def test_ab_test_better_model(self):
        """Test A/B test with better model."""
        from xgboost import XGBClassifier
        
        validator = ModelValidator(min_improvement=0.001)
        
        np.random.seed(42)
        X = np.random.rand(500, 20).astype(np.float32)
        y = np.random.randint(0, 2, 500)
        X_test = np.random.rand(100, 20).astype(np.float32)
        y_test = np.random.randint(0, 2, 100)
        
        # Weak model
        model_a = XGBClassifier(n_estimators=5, max_depth=2, random_state=42, use_label_encoder=False)
        model_a.fit(X[:100], y[:100])
        
        # Better model (more data, more trees)
        model_b = XGBClassifier(n_estimators=50, max_depth=5, random_state=42, use_label_encoder=False)
        model_b.fit(X, y)
        
        result = validator.ab_test(model_a, model_b, X_test, y_test)
        
        # Better model metrics should be captured
        assert 'model_a' in result
        assert 'model_b' in result
        assert 'improvements' in result
        assert 'decision' in result
    
    def test_comparison_report(self):
        """Test generating comparison report."""
        validator = ModelValidator()
        
        result = {
            'model_a': {'f1_score': 0.85, 'auc_roc': 0.90, 'precision': 0.80, 'recall': 0.90},
            'model_b': {'f1_score': 0.88, 'auc_roc': 0.92, 'precision': 0.82, 'recall': 0.94},
            'improvements': {'f1_score': 0.03, 'auc_roc': 0.02, 'precision': 0.02, 'recall': 0.04},
            'p_value': 0.01,
            'is_significant': True,
            'decision': 'DEPLOY_NEW_MODEL',
            'reasons': ['Test reason'],
            'test_samples': 100
        }
        
        report = validator.generate_comparison_report(result)
        
        assert 'MODEL COMPARISON REPORT' in report
        assert 'F1-score' in report
        assert 'DEPLOY_NEW_MODEL' in report


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
