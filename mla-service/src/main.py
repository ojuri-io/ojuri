"""
Main entry point for Model Learning Agent (MLA) service.
Orchestrates drift detection, retraining, and deployment.

Also exposes a tiny HTTP server on `METRICS_PORT` (default 9095) so the
operator dashboard / system-health page can answer "is the automated
retraining loop actually running?" without shelling into the container.
"""

import signal
import socketserver
import sys
import threading
import time
import pickle
import os
from http.server import ThreadingHTTPServer
from typing import Any, Dict, Optional

from src.api.handler import make_handler
from src.config import config
from src.consumer.kafka_consumer import KafkaConsumerService
from src.monitoring.drift_detector import DriftDetector
from src.training.data_loader import DataLoader
from src.training.preprocessor import DataPreprocessor
from src.training.trainer import ModelTrainer
from src.training.validator import ModelValidator
from src.deployment.onnx_converter import ONNXConverter
from src.deployment.model_registry import ModelRegistry
from src.utils.logger import setup_logger

logger = setup_logger('MLA', config.LOG_LEVEL)


class MLAService:
    """
    Model Learning Agent Service.

    Workflow:
    1. Load current production model from registry (if exists)
    2. Monitor Kafka for drift signals
    3. When drift detected:
       - Load training data from PostgreSQL
       - Preprocess (SMOTE + normalization)
       - Train new XGBoost model
       - A/B test vs current model
       - If better: Convert to ONNX and deploy
       - Update drift detector baseline
    """

    def __init__(self):
        logger.info("=" * 70)
        logger.info("MODEL LEARNING AGENT STARTING")
        logger.info("=" * 70)

        # Initialize components
        logger.info("Initializing components...")

        self.config = config
        self.drift_detector = DriftDetector(
            window_size=config.DRIFT_WINDOW_SIZE,
            f1_threshold=config.DRIFT_F1_THRESHOLD,
            psi_threshold=config.DRIFT_PSI_THRESHOLD
        )
        self.data_loader = DataLoader()
        self.preprocessor = DataPreprocessor()
        self.trainer = ModelTrainer(config)
        self.validator = ModelValidator()
        self.onnx_converter = ONNXConverter()
        self.model_registry = ModelRegistry(config)
        self.kafka_consumer = KafkaConsumerService(config, self.drift_detector)

        # Model state
        self.current_model = None
        self.current_model_version = "v1.0"
        self.next_version = "v1.0"
        self.retraining_in_progress = False

        # Telemetry for the operator dashboard. Mirrors FIA's /stats so
        # the frontend can render every service the same way.
        self._stats: Dict[str, Any] = {
            "service": "mla",
            "started_at": time.time(),
            "drift_checks": 0,
            "drift_detected_count": 0,
            "retrainings_started": 0,
            "retrainings_succeeded": 0,
            "retrainings_failed": 0,
            "last_drift_check_at": None,
            "last_drift_detected_at": None,
            "last_retraining_started_at": None,
            "last_retraining_completed_at": None,
            "last_deployed_model_version": None,
            "last_error": None,
            "drift_f1_threshold": config.DRIFT_F1_THRESHOLD,
            "drift_psi_threshold": config.DRIFT_PSI_THRESHOLD,
        }

        self._http_server: Optional[socketserver.TCPServer] = None
        self._http_thread: Optional[threading.Thread] = None

        # Create directories
        os.makedirs(config.MODEL_OUTPUT_DIR, exist_ok=True)
        os.makedirs(config.DATA_CACHE_DIR, exist_ok=True)

        logger.info("✅ All components initialized")

        # ═══════════════════════════════════════════════════════════════
        # CRITICAL: Load current production model
        # ═══════════════════════════════════════════════════════════════
        self._load_production_model()

    def _load_production_model(self):
        """
        Load current production model from registry.

        CRITICAL FIX:
        Without this, MLA has no baseline for A/B testing and doesn't
        track the actual production model version.

        This method:
        1. Checks registry for latest model
        2. Downloads both ONNX (for verification) and pickle (for A/B)
        3. Loads pickle into self.current_model
        4. Sets self.current_model_version
        """
        logger.info("")
        logger.info("=" * 70)
        logger.info("LOADING PRODUCTION MODEL")
        logger.info("=" * 70)

        try:
            # Check for existing production model
            latest_model_info = self.model_registry.get_latest_model()

            if latest_model_info:
                logger.info(f"Found production model in registry:")
                logger.info(f"  Name: {latest_model_info['name']}")
                logger.info(f"  Version: {latest_model_info['version']}")
                logger.info(f"  Size: {latest_model_info['size_mb']:.2f} MB")
                logger.info(f"  Modified: {latest_model_info['modified']}")

                # Display metadata if available
                metadata = latest_model_info.get('metadata', {})
                if metadata:
                    logger.info(f"  F1-score: {metadata.get('f1_score', 'N/A')}")
                    logger.info(f"  AUC-ROC: {metadata.get('auc_roc', 'N/A')}")

                # Download model files
                local_onnx_path = os.path.join(
                    config.MODEL_OUTPUT_DIR,
                    'current_production_model.onnx'
                )

                self.model_registry.download_model(
                    object_name=latest_model_info['name'],
                    local_path=local_onnx_path,
                    download_pickle=True  # Also download pickle for A/B testing
                )

                # Load pickled model for A/B testing
                pickle_path = local_onnx_path.replace('.onnx', '.pkl')

                if os.path.exists(pickle_path):
                    with open(pickle_path, 'rb') as f:
                        self.current_model = pickle.load(f)

                    logger.info(f"✅ Production model loaded successfully")
                    logger.info(f"   Version: {latest_model_info['version']}")

                    # Set version
                    self.current_model_version = latest_model_info['version']

                    # Increment minor version for next training
                    version_parts = self.current_model_version.replace('v', '').split('.')
                    major, minor = int(version_parts[0]), int(version_parts[1]) if len(version_parts) > 1 else 0
                    self.next_version = f"v{major}.{minor + 1}"

                    logger.info(f"   Next version will be: {self.next_version}")

                else:
                    logger.warning("⚠️  Pickle file not found - cannot load for A/B testing")
                    logger.warning("   First retraining will deploy without comparison")
                    self.current_model = None
                    self.next_version = "v1.1"

            else:
                logger.warning("⚠️  No production model found in registry")
                logger.warning("   This is normal for first deployment")
                logger.warning("   First retraining will deploy without A/B test")
                self.current_model = None
                self.next_version = "v1.0"

        except Exception as e:
            logger.error(f"Failed to load production model: {e}", exc_info=True)
            logger.warning("Continuing without production model")
            logger.warning("First retraining will deploy without A/B test")
            self.current_model = None
            self.next_version = "v1.0"

        logger.info("=" * 70)
        logger.info("")

    def train_initial_model(self):
        """
        Train initial model without drift trigger.

        Use this for cold start or manual retraining.
        """
        logger.info("")
        logger.info("=" * 70)
        logger.info("TRAINING INITIAL MODEL")
        logger.info("=" * 70)

        self._run_training_pipeline({'reason': 'initial_training'})

    def on_drift_detected(self, drift_metrics):
        """
        Callback when drift is detected.
        Triggers the full retraining pipeline.
        """

        self._stats["drift_checks"] += 1
        self._stats["last_drift_check_at"] = time.time()
        self._stats["drift_detected_count"] += 1
        self._stats["last_drift_detected_at"] = time.time()

        if self.retraining_in_progress:
            logger.warning("Retraining already in progress, skipping...")
            return

        self._run_training_pipeline(drift_metrics)

    def _run_training_pipeline(self, drift_metrics):
        """Run the full training pipeline."""
        self.retraining_in_progress = True
        self._stats["retrainings_started"] += 1
        self._stats["last_retraining_started_at"] = time.time()

        try:
            logger.info("")
            logger.info("=" * 70)
            logger.info("STARTING AUTOMATED RETRAINING PIPELINE")
            logger.info("=" * 70)
            logger.info(f"Trigger: {drift_metrics.get('reason', 'Drift detected')}")
            logger.info("")

            # Step 1: Load training data
            logger.info("Step 1/7: Loading training data from PostgreSQL...")
            X, y = self.data_loader.load_training_data(
                limit=self.config.TRAINING_DATA_SIZE
            )

            # Step 2: Preprocess data
            logger.info("Step 2/7: Preprocessing data (SMOTE + normalization)...")
            X_train, X_val, X_test, y_train, y_val, y_test = \
                self.preprocessor.preprocess(X, y)

            # Step 3: Train new model
            logger.info("Step 3/7: Training XGBoost model...")
            new_model, training_metrics = self.trainer.train(
                X_train, y_train, X_val, y_val
            )

            # Step 4: Validate against current model (if exists)
            logger.info("Step 4/7: Validating new model...")

            if self.current_model is not None:
                logger.info("  Performing A/B test: new model vs production model")

                comparison = self.validator.ab_test(
                    self.current_model, new_model, X_test, y_test
                )

                report = self.validator.generate_comparison_report(comparison)
                logger.info(f"\n{report}")

                if comparison['decision'] != 'DEPLOY_NEW_MODEL':
                    logger.warning("=" * 70)
                    logger.warning("⚠️  NEW MODEL NOT BETTER THAN CURRENT")
                    logger.warning("   Keeping current production model")
                    logger.warning("   No deployment will occur")
                    logger.warning("=" * 70)
                    self.retraining_in_progress = False
                    return

                logger.info("✅ New model is significantly better - proceeding with deployment")

            else:
                logger.info("  No current production model - skipping A/B test")
                logger.info("  New model will be deployed automatically")

            # Step 5: Convert to ONNX. The input dimension must match
            # the catalogue length so the resulting model's first-axis
            # input shape lines up with what RDA's feature-builder
            # produces at serve time.
            logger.info("Step 5/7: Converting to ONNX format...")
            model_path = os.path.join(
                config.MODEL_OUTPUT_DIR,
                f'fraud_model_{self.next_version}.onnx'
            )

            from src.features.catalog import load_catalog
            catalog = load_catalog()
            self.onnx_converter.convert_to_onnx(
                new_model,
                self.preprocessor.get_scaler(),
                model_path,
                num_features=catalog.input_dimension,
            )

            # Step 6: Upload to registry
            logger.info("Step 6/7: Uploading to Model Registry...")
            metadata = {
                **training_metrics,
                'drift_metrics': drift_metrics,
                'timestamp': time.time(),
                'training_data_size': len(X_train)
            }

            self.model_registry.upload_model(
                model=new_model,  # Pass model object for pickling
                model_path=model_path,
                version=self.next_version,
                metadata=metadata
            )

            # Step 7: Update MLA state
            logger.info("Step 7/7: Updating MLA state...")

            self.current_model = new_model
            self.current_model_version = self.next_version

            # Prepare next version
            version_parts = self.current_model_version.replace('v', '').split('.')
            major, minor = int(version_parts[0]), int(version_parts[1]) if len(version_parts) > 1 else 0
            self.next_version = f"v{major}.{minor + 1}"

            # Update drift detector baseline
            baseline_distributions = self.data_loader.get_feature_distributions(X)
            self.drift_detector.set_baseline_distributions(baseline_distributions)
            self.drift_detector.reset()

            logger.info("")
            logger.info("=" * 70)
            logger.info("✅ RETRAINING PIPELINE COMPLETE")
            logger.info("=" * 70)
            logger.info(f"   New model version: {self.current_model_version}")
            logger.info(f"   F1-score: {training_metrics['f1_score']:.4f}")
            logger.info(f"   Deployed to registry: ✓")
            logger.info(f"   RDA will auto-update within 5 minutes")
            logger.info("=" * 70)
            logger.info("")

            self._stats["retrainings_succeeded"] += 1
            self._stats["last_retraining_completed_at"] = time.time()
            self._stats["last_deployed_model_version"] = self.current_model_version

        except Exception as e:
            logger.error("=" * 70)
            logger.error("❌ RETRAINING PIPELINE FAILED")
            logger.error("=" * 70)
            logger.error(f"Error: {e}", exc_info=True)
            logger.error("=" * 70)
            self._stats["retrainings_failed"] += 1
            self._stats["last_error"] = str(e)

        finally:
            self.retraining_in_progress = False

    # ════════════════════════════════════════════════════════════════
    # HTTP surface — consumed by the operator dashboard
    # ════════════════════════════════════════════════════════════════
    def is_ready(self) -> bool:
        """Service is 'ready' when the Kafka consumer is connected."""
        try:
            return self.kafka_consumer.is_connected()
        except Exception:
            return False

    def stats(self) -> Dict[str, Any]:
        snapshot = dict(self._stats)
        snapshot["current_model_version"] = self.current_model_version
        snapshot["retraining_in_progress"] = self.retraining_in_progress
        snapshot["uptime_seconds"] = int(time.time() - self._stats["started_at"])
        return snapshot

    def _start_http_server(self) -> None:
        # ThreadingHTTPServer so a slow retraining-pipeline log query
        # or future status call can't queue behind another and make
        # `/livez` look dead to the dashboard. Same reasoning as FIA.
        ThreadingHTTPServer.allow_reuse_address = True
        try:
            self._http_server = ThreadingHTTPServer(
                ("0.0.0.0", config.METRICS_PORT), make_handler(self)
            )
            self._http_thread = threading.Thread(
                target=self._http_server.serve_forever, name="mla-http", daemon=True
            )
            self._http_thread.start()
            logger.info(f"HTTP server listening on :{config.METRICS_PORT}")
        except OSError as e:
            logger.warning(f"HTTP server failed to bind on :{config.METRICS_PORT} ({e})")

    def _stop_http_server(self) -> None:
        if self._http_server is not None:
            try:
                self._http_server.shutdown()
                self._http_server.server_close()
            except Exception as e:
                logger.warning(f"Error stopping HTTP server: {e}")

    def run(self):
        """Main service loop."""
        logger.info("=" * 70)
        logger.info("MLA SERVICE READY")
        logger.info("=" * 70)
        logger.info(f"Configuration:")
        logger.info(f"  Training data size: {config.TRAINING_DATA_SIZE:,}")
        logger.info(f"  Drift F1 threshold: {config.DRIFT_F1_THRESHOLD}")
        logger.info(f"  Drift PSI threshold: {config.DRIFT_PSI_THRESHOLD}")
        logger.info(f"  Current model version: {self.current_model_version}")
        logger.info("=" * 70)
        logger.info("")

        # Start health server BEFORE attempting Kafka. The dashboard
        # needs to see /livez even if Kafka is down so operators can
        # distinguish "MLA dead" from "MLA can't reach Kafka".
        self._start_http_server()

        # Set up graceful shutdown
        def signal_handler(sig, frame):
            logger.info("")
            logger.info("=" * 70)
            logger.info("SHUTTING DOWN GRACEFULLY")
            logger.info("=" * 70)
            self._stop_http_server()
            self.kafka_consumer.close()
            sys.exit(0)

        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)

        # Check if Kafka is available
        if self.kafka_consumer.is_connected():
            # Start consuming
            logger.info("Starting Kafka consumer...")
            logger.info("Monitoring for concept drift...")
            logger.info("")

            self.kafka_consumer.consume_and_monitor(self.on_drift_detected)
        else:
            logger.warning("Kafka not available - running in manual mode")
            logger.warning("Use train_initial_model() for manual training")
            logger.info("")
            logger.info("To train initial model, run:")
            logger.info("  python -c \"from src.main import MLAService; s = MLAService(); s.train_initial_model()\"")

            # Keep the process (and therefore /livez) alive even in
            # manual mode so operators can confirm "MLA up, Kafka
            # absent" from the dashboard.
            try:
                while True:
                    time.sleep(60)
            except KeyboardInterrupt:
                pass


if __name__ == '__main__':
    service = MLAService()

    # Check for command line arguments
    if len(sys.argv) > 1 and sys.argv[1] == '--train':
        # Manual training mode
        service.train_initial_model()
    else:
        # Normal operation mode
        service.run()
