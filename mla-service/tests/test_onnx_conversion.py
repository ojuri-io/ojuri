"""
Test ONNX conversion to validate compatibility.
Run this EARLY to catch any version issues.
"""

import pytest
import numpy as np
import os
import tempfile
from xgboost import XGBClassifier
from sklearn.preprocessing import StandardScaler

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from src.deployment.onnx_converter import ONNXConverter


def test_onnx_conversion_basic():
    """
    Test basic ONNX conversion with dummy model.
    This validates that our dependency versions are compatible.
    """
    
    # Create dummy training data
    np.random.seed(42)
    X_dummy = np.random.rand(100, 434).astype(np.float32)
    y_dummy = np.random.randint(0, 2, 100)
    
    # Train simple model
    model = XGBClassifier(
        n_estimators=10,
        max_depth=3,
        random_state=42,
        use_label_encoder=False
    )
    model.fit(X_dummy, y_dummy)
    
    # Create scaler
    scaler = StandardScaler()
    scaler.fit(X_dummy)
    
    # Convert to ONNX
    converter = ONNXConverter()
    
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, 'test_model.onnx')
        
        # This is the critical test - does conversion work?
        converter.convert_to_onnx(
            model=model,
            scaler=scaler,
            output_path=output_path,
            num_features=434
        )
        
        # Verify files created
        assert os.path.exists(output_path), "ONNX file not created"
        assert os.path.exists(output_path.replace('.onnx', '_scaler.npz')), \
            "Scaler file not created"
        
        # Verify file size reasonable
        file_size = os.path.getsize(output_path)
        assert file_size > 1000, f"ONNX file too small: {file_size} bytes"
        assert file_size < 50_000_000, f"ONNX file too large: {file_size} bytes"
        
        print(f"✅ ONNX file created: {file_size:,} bytes")


def test_onnx_inference():
    """
    Test that ONNX model can actually run inference.
    This validates ONNX Runtime compatibility.
    """
    import onnxruntime as ort
    
    # Create and convert model
    np.random.seed(42)
    X_dummy = np.random.rand(100, 434).astype(np.float32)
    y_dummy = np.random.randint(0, 2, 100)
    
    model = XGBClassifier(n_estimators=10, max_depth=3, random_state=42, use_label_encoder=False)
    model.fit(X_dummy, y_dummy)
    
    scaler = StandardScaler()
    scaler.fit(X_dummy)
    
    converter = ONNXConverter()
    
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, 'test_model.onnx')
        converter.convert_to_onnx(model, scaler, output_path, num_features=434)
        
        # Load ONNX model
        session = ort.InferenceSession(output_path)
        
        # Get input name
        input_name = session.get_inputs()[0].name
        
        # Test inference
        test_input = np.random.rand(1, 434).astype(np.float32)
        result = session.run(None, {input_name: test_input})
        
        # Verify output
        assert result is not None, "ONNX inference returned None"
        assert len(result) > 0, "ONNX inference returned empty result"
        
        output = result[0]
        probability = float(output[0]) if output.ndim == 1 else float(output[0][0])
        
        # Check that probability is reasonable
        assert 0 <= probability <= 1, f"Invalid probability: {probability}"
        
        print(f"✅ ONNX inference test passed")
        print(f"   Test prediction: {probability:.4f}")


def test_model_info():
    """Test getting model information."""
    np.random.seed(42)
    X_dummy = np.random.rand(50, 434).astype(np.float32)
    y_dummy = np.random.randint(0, 2, 50)
    
    model = XGBClassifier(n_estimators=5, max_depth=2, random_state=42, use_label_encoder=False)
    model.fit(X_dummy, y_dummy)
    
    scaler = StandardScaler()
    scaler.fit(X_dummy)
    
    converter = ONNXConverter()
    
    with tempfile.TemporaryDirectory() as tmpdir:
        output_path = os.path.join(tmpdir, 'test_model.onnx')
        converter.convert_to_onnx(model, scaler, output_path, num_features=434)
        
        # Get model info
        info = converter.get_model_info(output_path)
        
        assert 'ir_version' in info
        assert 'inputs' in info
        assert 'outputs' in info
        assert info['file_size_bytes'] > 0
        
        print(f"✅ Model info test passed")
        print(f"   IR Version: {info['ir_version']}")
        print(f"   Inputs: {info['inputs']}")


if __name__ == '__main__':
    print("Testing ONNX conversion...")
    test_onnx_conversion_basic()
    test_onnx_inference()
    test_model_info()
    print("✅ All ONNX tests passed!")
