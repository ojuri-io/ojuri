"""
Model registry for MinIO S3-compatible storage.
Handles model versioning, upload, download, and retrieval.
"""

from minio import Minio
from minio.error import S3Error
import logging
import os
import json
import pickle
from datetime import datetime
from typing import Optional, Dict, List

from src.config import config

logger = logging.getLogger(__name__)


class ModelRegistry:
    """
    Upload/download models from MinIO S3-compatible storage.
    
    Features:
    - Versioned model storage
    - Metadata tracking
    - Scaler parameter storage
    - Both ONNX (for RDA) and pickle (for MLA) storage
    """
    
    def __init__(self, config):
        """Initialize MinIO client and create bucket if needed."""
        try:
            self.client = Minio(
                config.MINIO_ENDPOINT,
                access_key=config.MINIO_ACCESS_KEY,
                secret_key=config.MINIO_SECRET_KEY,
                secure=config.MINIO_SECURE
            )
            
            self.bucket = config.MINIO_BUCKET
            
            # Create bucket if it doesn't exist
            if not self.client.bucket_exists(self.bucket):
                self.client.make_bucket(self.bucket)
                logger.info(f"Created MinIO bucket: {self.bucket}")
            
            logger.info(f"✅ ModelRegistry connected: {config.MINIO_ENDPOINT}/{self.bucket}")
            
        except S3Error as e:
            logger.error(f"❌ MinIO connection failed: {e}")
            raise
        except Exception as e:
            logger.warning(f"⚠️  MinIO not available: {e}")
            logger.warning("   Running in local-only mode (models saved locally)")
            self.client = None
            self.bucket = None
    
    def upload_model(
        self, 
        model, 
        model_path: str, 
        version: str, 
        metadata: dict
    ) -> str:
        """
        Upload model to registry with versioning.
        
        Uploads THREE files:
        1. ONNX model (for RDA inference)
        2. Pickled XGBoost (for MLA A/B testing)
        3. Metadata JSON
        
        Args:
            model: Trained XGBoost model object
            model_path: Local path to .onnx file
            version: Model version (e.g., "v1.0")
            metadata: Model metadata dict
        
        Returns:
            Base object name (without extension)
        """
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        base_name = f"fraud_model_{timestamp}_{version}"
        
        logger.info(f"Uploading model to registry...")
        logger.info(f"  Version: {version}")
        
        # If MinIO not available, save locally only
        if self.client is None:
            logger.warning("MinIO not available - saving locally only")
            return self._save_locally(model, model_path, version, metadata)
        
        logger.info(f"  Bucket: {self.bucket}")
        
        try:
            # 1. Upload ONNX file (for RDA)
            onnx_object_name = f"{base_name}.onnx"
            self.client.fput_object(
                bucket_name=self.bucket,
                object_name=onnx_object_name,
                file_path=model_path,
                content_type='application/octet-stream'
            )
            logger.info(f"  ✅ ONNX: {onnx_object_name}")
            
            # 2. Upload pickled model (for MLA A/B testing)
            pickle_path = model_path.replace('.onnx', '.pkl')
            with open(pickle_path, 'wb') as f:
                pickle.dump(model, f)
            
            pickle_object_name = f"{base_name}.pkl"
            self.client.fput_object(
                bucket_name=self.bucket,
                object_name=pickle_object_name,
                file_path=pickle_path
            )
            logger.info(f"  ✅ Pickle: {pickle_object_name}")
            
            # 3. Upload metadata
            metadata_name = f"{base_name}_metadata.json"
            metadata_path = model_path.replace('.onnx', '_metadata.json')
            
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2, default=str)
            
            self.client.fput_object(
                bucket_name=self.bucket,
                object_name=metadata_name,
                file_path=metadata_path,
                content_type='application/json'
            )
            logger.info(f"  ✅ Metadata: {metadata_name}")
            
            # 4. Upload scaler if exists
            scaler_path = model_path.replace('.onnx', '_scaler.npz')
            if os.path.exists(scaler_path):
                scaler_name = f"{base_name}_scaler.npz"
                self.client.fput_object(
                    bucket_name=self.bucket,
                    object_name=scaler_name,
                    file_path=scaler_path
                )
                logger.info(f"  ✅ Scaler: {scaler_name}")
            
            logger.info(f"✅ Model upload complete: {base_name}")
            
            return base_name
            
        except S3Error as e:
            logger.error(f"❌ Upload failed: {e}")
            raise
    
    def _save_locally(
        self,
        model,
        model_path: str,
        version: str,
        metadata: dict
    ) -> str:
        """Save model locally when MinIO is not available."""
        base_name = f"fraud_model_{version}"
        
        # Save pickle
        pickle_path = model_path.replace('.onnx', '.pkl')
        with open(pickle_path, 'wb') as f:
            pickle.dump(model, f)
        logger.info(f"  ✅ Pickle: {pickle_path}")
        
        # Save metadata
        metadata_path = model_path.replace('.onnx', '_metadata.json')
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f, indent=2, default=str)
        logger.info(f"  ✅ Metadata: {metadata_path}")
        
        return base_name
    
    def list_models(self) -> List[Dict]:
        """
        List all models in registry.
        
        Returns:
            List of model info dicts
        """
        if self.client is None:
            return self._list_local_models()
        
        try:
            objects = self.client.list_objects(self.bucket, prefix='fraud_model_')
            
            models = []
            for obj in objects:
                if obj.object_name.endswith('.onnx'):
                    models.append({
                        'name': obj.object_name,
                        'size_mb': obj.size / (1024 * 1024),
                        'modified': obj.last_modified.strftime('%Y-%m-%d %H:%M:%S'),
                        'version': self._extract_version(obj.object_name)
                    })
            
            # Sort by modification time (newest first)
            models.sort(key=lambda x: x['modified'], reverse=True)
            
            return models
            
        except S3Error as e:
            logger.error(f"Error listing models: {e}")
            return []
    
    def _list_local_models(self) -> List[Dict]:
        """List models from local directory."""
        models = []
        model_dir = config.MODEL_OUTPUT_DIR
        
        if not os.path.exists(model_dir):
            return models
        
        for filename in os.listdir(model_dir):
            if filename.endswith('.onnx'):
                filepath = os.path.join(model_dir, filename)
                stat = os.stat(filepath)
                models.append({
                    'name': filename,
                    'size_mb': stat.st_size / (1024 * 1024),
                    'modified': datetime.fromtimestamp(stat.st_mtime).strftime('%Y-%m-%d %H:%M:%S'),
                    'version': self._extract_version(filename)
                })
        
        models.sort(key=lambda x: x['modified'], reverse=True)
        return models
    
    def get_latest_model(self) -> Optional[Dict]:
        """
        Get info about the latest (most recent) model.
        
        Returns:
            Dict with model info or None if no models found
        """
        models = self.list_models()
        
        if not models:
            logger.warning("No models found in registry")
            return None
        
        latest = models[0]  # Already sorted by newest first
        
        # Try to load metadata
        if self.client:
            metadata_name = latest['name'].replace('.onnx', '_metadata.json')
            try:
                response = self.client.get_object(self.bucket, metadata_name)
                metadata = json.loads(response.read().decode('utf-8'))
                latest['metadata'] = metadata
            except Exception as e:
                logger.warning(f"Could not load metadata for {latest['name']}: {e}")
                latest['metadata'] = {}
        else:
            # Load from local file
            metadata_path = os.path.join(
                config.MODEL_OUTPUT_DIR,
                latest['name'].replace('.onnx', '_metadata.json')
            )
            if os.path.exists(metadata_path):
                with open(metadata_path) as f:
                    latest['metadata'] = json.load(f)
            else:
                latest['metadata'] = {}
        
        return latest
    
    def download_model(
        self, 
        object_name: str, 
        local_path: str,
        download_pickle: bool = True
    ) -> str:
        """
        Download model from registry.
        
        Args:
            object_name: S3 object name (e.g., 'fraud_model_20240417_v1.2.onnx')
            local_path: Where to save locally
            download_pickle: Also download pickled version for A/B testing
        
        Returns:
            Local path to downloaded file
        """
        if self.client is None:
            logger.warning("MinIO not available - checking local files")
            return self._copy_local_model(object_name, local_path)
        
        try:
            # Create directory
            os.makedirs(os.path.dirname(local_path) or '.', exist_ok=True)
            
            # Download ONNX
            self.client.fget_object(
                bucket_name=self.bucket,
                object_name=object_name,
                file_path=local_path
            )
            logger.info(f"✅ Downloaded ONNX: {local_path}")
            
            # Download pickle if requested
            if download_pickle:
                pickle_object = object_name.replace('.onnx', '.pkl')
                pickle_path = local_path.replace('.onnx', '.pkl')
                
                try:
                    self.client.fget_object(
                        bucket_name=self.bucket,
                        object_name=pickle_object,
                        file_path=pickle_path
                    )
                    logger.info(f"✅ Downloaded pickle: {pickle_path}")
                except Exception as e:
                    logger.warning(f"Could not download pickle version: {e}")
            
            # Download scaler
            scaler_object = object_name.replace('.onnx', '_scaler.npz')
            scaler_path = local_path.replace('.onnx', '_scaler.npz')
            
            try:
                self.client.fget_object(
                    bucket_name=self.bucket,
                    object_name=scaler_object,
                    file_path=scaler_path
                )
                logger.info(f"✅ Downloaded scaler: {scaler_path}")
            except Exception as e:
                logger.warning(f"Could not download scaler: {e}")
            
            return local_path
            
        except S3Error as e:
            logger.error(f"❌ Download failed: {e}")
            raise
    
    def _copy_local_model(self, object_name: str, local_path: str) -> str:
        """Copy model from local models directory."""
        import shutil
        
        source_path = os.path.join(config.MODEL_OUTPUT_DIR, object_name)
        
        if os.path.exists(source_path):
            os.makedirs(os.path.dirname(local_path) or '.', exist_ok=True)
            shutil.copy2(source_path, local_path)
            logger.info(f"✅ Copied local model: {local_path}")
            return local_path
        else:
            raise FileNotFoundError(f"Model not found: {source_path}")
    
    def _extract_version(self, object_name: str) -> str:
        """Extract version string from object name."""
        try:
            # Format: fraud_model_20240417_143025_v1.2.onnx
            parts = object_name.split('_')
            for part in parts:
                if part.startswith('v'):
                    return part.replace('.onnx', '').replace('.pkl', '')
            return 'unknown'
        except:
            return 'unknown'
