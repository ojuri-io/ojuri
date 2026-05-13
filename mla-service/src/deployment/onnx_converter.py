"""
ONNX model conversion for production deployment.

Converts trained XGBoost models to ONNX format for:
- Fast inference in production (RDA service uses ONNX Runtime)
- Model portability across platforms
- Consistent inference behavior
"""

import numpy as np
import onnx
from onnxmltools import convert_xgboost
from onnxmltools.convert.common.data_types import FloatTensorType
import onnxruntime as ort
from sklearn.preprocessing import StandardScaler
import os
import logging

logger = logging.getLogger(__name__)


class ONNXConverter:
    """
    Convert XGBoost models to ONNX format.
    
    Also saves scaler parameters for preprocessing in production.
    
    Example:
        >>> converter = ONNXConverter()
        >>> converter.convert_to_onnx(model, scaler, './models/fraud_model.onnx')
    """
    
    def __init__(self):
        logger.info("ONNXConverter initialized")
    
    def convert_to_onnx(
        self,
        model,
        scaler: StandardScaler,
        output_path: str,
        num_features: int = 434
    ) -> str:
        """
        Convert XGBoost model to ONNX format.
        
        Saves three files:
        1. {output_path} - ONNX model file
        2. {output_path}_scaler.npz - Scaler parameters
        3. {output_path}_metadata.json - Model metadata
        
        Args:
            model: Trained XGBoost classifier
            scaler: Fitted StandardScaler
            output_path: Path for ONNX file (e.g., './models/fraud_model.onnx')
            num_features: Number of input features
        
        Returns:
            Path to saved ONNX file
        """
        logger.info("=" * 70)
        logger.info("CONVERTING MODEL TO ONNX")
        logger.info("=" * 70)
        logger.info(f"Output path: {output_path}")
        logger.info(f"Input features: {num_features}")
        
        # Create output directory if needed
        os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
        
        # Step 1: Convert XGBoost to ONNX
        logger.info("Step 1: Converting XGBoost to ONNX...")
        
        # Define input type
        initial_type = [('input', FloatTensorType([None, num_features]))]
        
        try:
            # Convert model
            onnx_model = convert_xgboost(
                model,
                initial_types=initial_type,
                target_opset=12
            )
            
            # Save ONNX model
            onnx.save_model(onnx_model, output_path)
            
            file_size = os.path.getsize(output_path)
            logger.info(f"  ✅ ONNX model saved: {file_size:,} bytes")
            
        except Exception as e:
            logger.error(f"  ❌ ONNX conversion failed: {e}")
            raise
        
        # Step 2: Save scaler parameters
        logger.info("Step 2: Saving scaler parameters...")
        
        scaler_path = output_path.replace('.onnx', '_scaler.npz')
        
        try:
            np.savez(
                scaler_path,
                mean=scaler.mean_,
                scale=scaler.scale_,
                var=scaler.var_
            )
            logger.info(f"  ✅ Scaler saved: {scaler_path}")
            
        except Exception as e:
            logger.error(f"  ❌ Failed to save scaler: {e}")
            raise
        
        # Step 3: Validate ONNX model
        logger.info("Step 3: Validating ONNX model...")
        
        try:
            self._validate_onnx(output_path, num_features)
            logger.info("  ✅ ONNX validation passed")
            
        except Exception as e:
            logger.error(f"  ❌ ONNX validation failed: {e}")
            raise
        
        logger.info("=" * 70)
        logger.info("✅ ONNX CONVERSION COMPLETE")
        logger.info("=" * 70)
        
        return output_path
    
    def _validate_onnx(self, model_path: str, num_features: int):
        """
        Validate ONNX model by running test inference.
        
        Args:
            model_path: Path to ONNX model
            num_features: Number of input features
        
        Raises:
            RuntimeError: If validation fails
        """
        # Load model with ONNX Runtime
        session = ort.InferenceSession(model_path)
        
        # Create test input
        test_input = np.random.rand(1, num_features).astype(np.float32)
        
        # Get input name
        input_name = session.get_inputs()[0].name
        
        # Run inference
        result = session.run(None, {input_name: test_input})
        
        # Verify output
        if result is None or len(result) == 0:
            raise RuntimeError("ONNX model returned empty result")
        
        output = result[0]
        
        # Check output shape and values
        if output.shape[0] != 1:
            raise RuntimeError(f"Unexpected output shape: {output.shape}")
        
        # For classifier output, value should be probability
        prob = float(output[0])
        if not (0 <= prob <= 1):
            raise RuntimeError(f"Invalid probability output: {prob}")
        
        logger.debug(f"Validation inference: probability = {prob:.4f}")
    
    def load_and_predict(
        self,
        model_path: str,
        features: np.ndarray,
        scaler_path: str = None
    ) -> np.ndarray:
        """
        Load ONNX model and run prediction.
        
        Useful for testing converted models.
        
        Args:
            model_path: Path to ONNX model
            features: Input features (batch_size x num_features)
            scaler_path: Optional path to scaler parameters
        
        Returns:
            Array of fraud probabilities
        """
        # Load scaler if provided
        if scaler_path and os.path.exists(scaler_path):
            scaler_data = np.load(scaler_path)
            mean = scaler_data['mean']
            scale = scaler_data['scale']
            features = (features - mean) / scale
        
        # Ensure float32
        features = features.astype(np.float32)
        
        # Load model
        session = ort.InferenceSession(model_path)
        input_name = session.get_inputs()[0].name
        
        # Run inference
        result = session.run(None, {input_name: features})
        
        return result[0]
    
    def get_model_info(self, model_path: str) -> dict:
        """
        Get information about an ONNX model.
        
        Args:
            model_path: Path to ONNX model
        
        Returns:
            Dict with model metadata
        """
        model = onnx.load(model_path)
        
        info = {
            'ir_version': model.ir_version,
            'producer_name': model.producer_name,
            'producer_version': model.producer_version,
            'opset_version': model.opset_import[0].version if model.opset_import else None,
            'graph_name': model.graph.name,
            'inputs': [],
            'outputs': [],
            'file_size_bytes': os.path.getsize(model_path)
        }
        
        # Get input info
        for input_tensor in model.graph.input:
            shape = []
            if input_tensor.type.tensor_type.shape.dim:
                for dim in input_tensor.type.tensor_type.shape.dim:
                    shape.append(dim.dim_value if dim.dim_value else 'dynamic')
            info['inputs'].append({
                'name': input_tensor.name,
                'shape': shape
            })
        
        # Get output info
        for output_tensor in model.graph.output:
            info['outputs'].append({
                'name': output_tensor.name
            })
        
        return info
