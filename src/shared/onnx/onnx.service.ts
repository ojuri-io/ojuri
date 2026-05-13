import * as ort from "onnxruntime-node";
import { singleton } from "tsyringe";
import appConfig from "@config/app.config";
import { createServiceLogger, TraceContext } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import { createCircuitBreaker } from "@shared/circuit-breaker/circuit-breaker";
import type CircuitBreaker from "opossum";
import fs from "fs";
import path from "path";

const onnxLogger = createServiceLogger("OnnxService");

/**
 * ONNX Runtime service for ML model inference
 * Handles model loading, inference, and hot-reloading
 */
@singleton()
class OnnxService {
  private session: ort.InferenceSession | null = null;
  private modelPath: string;
  private modelETag: string | null = null;
  private inferenceCircuitBreaker: CircuitBreaker<any[], any>;
  private isModelLoaded: boolean = false;

  constructor() {
    this.modelPath = path.resolve(appConfig.onnx.modelPath);
    this.setupCircuitBreaker();
  }

  private setupCircuitBreaker(): void {
    // Create circuit breaker for inference
    this.inferenceCircuitBreaker = createCircuitBreaker(
      async (features: Float32Array) => this.runInference(features),
      {
        name: "onnx-inference",
        timeout: appConfig.circuitBreaker.onnx.timeout,
        errorThresholdPercentage: appConfig.circuitBreaker.onnx.errorThresholdPercentage,
        resetTimeout: appConfig.circuitBreaker.onnx.resetTimeout,
        fallback: () => {
          // FAIL-CLOSED policy - decline all transactions when model fails
          onnxLogger.error("fallback", "ONNX circuit breaker fallback triggered - declining transaction", {
            traceId: TraceContext.getTraceId(),
          });
          return 1.0; // Return max probability to trigger decline
        },
      }
    );
  }

  /**
   * Initialize ONNX model - load on startup
   */
  async initialize(): Promise<void> {
    try {
      await this.loadModel();
      this.startModelPolling();
      onnxLogger.success("initialize", "ONNX service initialized successfully", {});
    } catch (err) {
      onnxLogger.error("initialize", "Failed to initialize ONNX service", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Load ONNX model from disk
   */
  private async loadModel(): Promise<void> {
    const startTime = Date.now();

    try {
      // Check if model file exists
      if (!fs.existsSync(this.modelPath)) {
        onnxLogger.warn("loadModel", "Model file not found, creating placeholder", {
          modelPath: this.modelPath,
        });
        await this.createPlaceholderModel();
      }

      // Configure session options for optimal performance
      const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        enableCpuMemArena: true,
        enableMemPattern: true,
        executionMode: "sequential",
      };

      this.session = await ort.InferenceSession.create(this.modelPath, sessionOptions);
      this.isModelLoaded = true;

      const loadTime = Date.now() - startTime;
      metricsService.recordModelLoadTime(loadTime);

      onnxLogger.success("loadModel", "ONNX model loaded successfully", {
        loadTime,
        modelPath: this.modelPath,
      });
    } catch (err) {
      onnxLogger.error("loadModel", "Failed to load ONNX model", {
        modelPath: this.modelPath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Create a placeholder model for development/testing
   */
  private async createPlaceholderModel(): Promise<void> {
    // Create directory if it doesn't exist
    const modelDir = path.dirname(this.modelPath);
    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir, { recursive: true });
    }

    // Note: In production, this would be replaced by the actual trained model
    // For now, we'll create a simple placeholder that returns random predictions
    onnxLogger.warn("createPlaceholderModel", "Using placeholder model - replace with actual trained model in production", {});

    // We can't easily create an ONNX model programmatically in Node.js
    // So we'll set a flag to use mock inference
    this.isModelLoaded = false;
  }

  /**
   * Start polling for model updates
   */
  private startModelPolling(): void {
    if (!appConfig.onnx.modelRegistryUrl) {
      onnxLogger.debug("startModelPolling", "Model registry URL not configured, skipping model polling", {});
      return;
    }

    setInterval(async () => {
      await this.checkForModelUpdate();
    }, appConfig.onnx.modelPollInterval);
  }

  /**
   * Check for model updates via HTTP HEAD request
   */
  private async checkForModelUpdate(): Promise<void> {
    if (!appConfig.onnx.modelRegistryUrl) return;

    try {
      const response = await fetch(appConfig.onnx.modelRegistryUrl, { method: "HEAD" });
      const etag = response.headers.get("etag");

      if (etag && etag !== this.modelETag) {
        onnxLogger.entry("checkForModelUpdate", "New model version detected", {
          oldETag: this.modelETag,
          newETag: etag,
        });
        await this.downloadAndLoadModel();
        this.modelETag = etag;
      }
    } catch (err) {
      onnxLogger.error("checkForModelUpdate", "Failed to check for model update", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Download and load new model version
   */
  private async downloadAndLoadModel(): Promise<void> {
    if (!appConfig.onnx.modelRegistryUrl) return;

    try {
      const response = await fetch(appConfig.onnx.modelRegistryUrl);
      const buffer = await response.arrayBuffer();

      // Write to temp file first
      const tempPath = `${this.modelPath}.tmp`;
      fs.writeFileSync(tempPath, Buffer.from(buffer));

      // Rename to actual path (atomic operation)
      fs.renameSync(tempPath, this.modelPath);

      // Reload model
      await this.loadModel();

      onnxLogger.success("downloadAndLoadModel", "Model updated successfully", {});
    } catch (err) {
      onnxLogger.error("downloadAndLoadModel", "Failed to download and load new model", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Run inference on feature vector using circuit breaker
   * @param features - Feature vector (434 dimensions)
   * @returns Fraud probability (0.0 - 1.0)
   */
  async predict(features: Float32Array): Promise<number> {
    return this.inferenceCircuitBreaker.fire(features);
  }

  /**
   * Internal inference method
   */
  private async runInference(features: Float32Array): Promise<number> {
    const startTime = Date.now();
    const traceId = TraceContext.getTraceId();

    try {
      if (!this.session || !this.isModelLoaded) {
        // Use mock inference for development
        return this.mockInference(features);
      }

      // Create input tensor
      const inputTensor = new ort.Tensor("float32", features, [1, features.length]);

      // Run inference
      const feeds = { input: inputTensor };
      const results = await this.session.run(feeds);

      // Extract probability from output
      const output = results.output || results.probabilities || Object.values(results)[0];
      const probability = (output.data as Float32Array)[0];

      const inferenceTime = Date.now() - startTime;
      metricsService.recordModelInferenceLatency(inferenceTime);

      onnxLogger.debug("runInference", "Model inference completed", {
        traceId,
        inferenceTime,
        probability,
      });

      return probability;
    } catch (err) {
      onnxLogger.error("runInference", "Model inference failed", {
        traceId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Mock inference for development/testing
   */
  /**
   * Mock inference for development/testing when no ONNX model is loaded
   * Feature positions match toFeatureVector() in feature.service.ts:
   *   0: velocity_1h, 1: velocity_24h, 2: velocity_7d
   *   3: avg_amount_30d, 4: std_amount_30d, 5: pagerank
   *   6: clustering_coef, 7: time_since_last_txn, 8: is_weekend, 9: hour_of_day
   *   10: amount (from enrichFeatures), 11: transaction_type
   */
  private mockInference(features: Float32Array): number {
    // Extract features by their actual positions
    const velocity1h = features[0] || 0;
    const velocity24h = features[1] || 0;
    const avgAmount30d = features[3] || 0;
    const pagerank = features[5] || 0;
    const amount = features[10] || 0; // Transaction amount from enrichFeatures

    // Simple heuristic for demo purposes
    let probability = 0.1;

    // High transaction amount relative to user's average
    if (avgAmount30d > 0 && amount > avgAmount30d * 3) probability += 0.25;
    else if (amount > 100000) probability += 0.3;
    else if (amount > 50000) probability += 0.2;
    else if (amount > 10000) probability += 0.1;

    // High velocity indicates suspicious activity
    if (velocity1h > 10) probability += 0.2;
    if (velocity24h > 50) probability += 0.15;

    // Low pagerank (new/peripheral user) slightly increases risk
    if (pagerank < 0.1) probability += 0.05;

    // Add small randomness for demo variety
    probability += Math.random() * 0.05;

    return Math.min(probability, 1.0);
  }

  /**
   * Check if model is loaded and ready
   */
  isReady(): boolean {
    return this.session !== null || !this.isModelLoaded; // Mock mode is also "ready"
  }

  /**
   * Get model info
   */
  getModelInfo(): { path: string; loaded: boolean; inputDimensions: number } {
    return {
      path: this.modelPath,
      loaded: this.isModelLoaded,
      inputDimensions: 434,
    };
  }
}

export default OnnxService;
