import numpy as np
from sklearn.linear_model import LogisticRegression
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType
import onnx
import os

# Create models directory
os.makedirs('models', exist_ok=True)
os.makedirs('../models', exist_ok=True)

# Create a simple model for testing
X = np.random.rand(100, 434).astype(np.float32)
y = np.random.randint(0, 2, 100)

model = LogisticRegression(max_iter=100)
model.fit(X, y)

# Convert to ONNX
initial_type = [('float_input', FloatTensorType([None, 434]))]
onnx_model = convert_sklearn(model, initial_types=initial_type)

# Save to both locations
onnx.save_model(onnx_model, 'models/fraud_model.onnx')
onnx.save_model(onnx_model, '../models/fraud_model.onnx')
print('✓ Mock ONNX model created in both locations')
