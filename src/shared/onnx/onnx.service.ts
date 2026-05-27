import * as ort from "onnxruntime-node";
import { container, singleton } from "tsyringe";
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
 * Handles model loading, inference, and hot-reloading.
 *
 * Hot-reload now follows the model registry — when MLA registers a
 * new model and POSTs `status=ACTIVE`, `ModelRegistryService` notifies
 * us via its `onActiveChange` listener. We resolve the row's
 * `sourceUri` (a relative path like `models/versions/v1.2.0/model.onnx`),
 * load the bytes, and atomically swap the session. The legacy
 * `MODEL_REGISTRY_URL` HTTP polling is retired in favour of this
 * filesystem-driven flow — `models/` is bind-mounted into RDA so any
 * write by MLA on the host is immediately visible.
 */
@singleton()
class OnnxService {
  private session: ort.InferenceSession | null = null;
  private modelPath: string;
  private inferenceCircuitBreaker: CircuitBreaker<any[], any>;
  private isModelLoaded: boolean = false;
  private unsubscribeActiveChange: (() => void) | null = null;

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
      // Subscribe synchronously so any ACTIVE-flip that happens between
      // `loadModel()` and the first request can't slip past us. The
      // dynamic import is still required to break the circular dep with
      // ModelRegistryService, but we now `await` it so initialize() does
      // not return until the listener is wired.
      await this.subscribeToRegistry();
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

    onnxLogger.warn(
      "createPlaceholderModel",
      "NO ONNX MODEL LOADED — predictions are running in degraded mock mode. " +
        "Train your first model with `cd mla-service && python scripts/train_initial_model.py` " +
        "and copy the resulting .onnx to models/fraud_model.onnx. /readyz will continue to " +
        "report DOWN until a real model is loaded.",
      { modelPath: this.modelPath }
    );

    this.isModelLoaded = false;
  }

  /**
   * Subscribe to ACTIVE-version changes published by
   * `ModelRegistryService`. Awaited from `initialize()`, so the listener
   * is wired before the server starts accepting requests. The dynamic
   * import is still used to break the circular construction dependency
   * with ModelRegistryService — but unlike a fire-and-forget `.then()`,
   * the awaiter blocks until the subscription is in place.
   */
  private async subscribeToRegistry(): Promise<void> {
    try {
      const { default: ModelRegistryService } = await import("@shared/models/model-registry.service");
      const registry = container.resolve(ModelRegistryService);
      this.unsubscribeActiveChange = registry.onActiveChange((current, previous) => {
        onnxLogger.info("activeChange", "ACTIVE model version changed", {
          from: previous?.version ?? "(none)",
          to: current?.version ?? "(none)",
        });
        if (!current) return;
        this.applyActiveVersion(current.sourceUri, current.metadata).catch((err) =>
          onnxLogger.error("applyActiveVersion", "Failed to load new ACTIVE model", {
            version: current.version,
            sourceUri: current.sourceUri,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      });
    } catch (err) {
      onnxLogger.warn("subscribeToRegistry", "Could not subscribe to registry", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load the ONNX bytes for a registered model's `sourceUri` and
   * atomically replace the current session. Supports `file://` URLs
   * and bare relative / absolute paths. Anything else (s3://, http://)
   * logs and skips — those schemes belong in a hosted-deployment
   * fork and aren't part of the open-source self-hosted flow.
   *
   * Schema-version check: when the registered row's `metadata` carries
   * a `feature_schema_version`, it must match the running catalogue.
   * A mismatch means the model was trained against a different
   * feature contract — loading would silently misalign input columns.
   * We refuse, log loudly, and keep the previous session running.
   */
  private async applyActiveVersion(
    sourceUri: string | null,
    metadata?: Record<string, unknown> | null
  ): Promise<void> {
    if (!sourceUri) return;

    if (metadata && typeof metadata.feature_schema_version === "string") {
      const { loadCatalog } = await import("@shared/features/feature-catalog");
      const expected = loadCatalog().schemaVersion;
      const reported = metadata.feature_schema_version as string;
      if (reported !== expected) {
        onnxLogger.error(
          "applyActiveVersion",
          "Refusing to load model — feature schema mismatch",
          { reported, expected }
        );
        throw new Error(
          `Feature schema mismatch: model was trained against '${reported}', running catalogue is '${expected}'. ` +
            `Either retrain the model against the current catalogue or revert the adopter overlay.`
        );
      }
    }

    let resolved: string;
    if (sourceUri.startsWith("file://")) {
      resolved = sourceUri.slice("file://".length);
    } else if (sourceUri.startsWith("/")) {
      resolved = sourceUri;
    } else if (/^[a-z]+:\/\//i.test(sourceUri)) {
      onnxLogger.warn("applyActiveVersion", "Non-local sourceUri scheme — skipping hot-reload", {
        sourceUri,
      });
      return;
    } else {
      resolved = path.resolve(process.cwd(), sourceUri);
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`Resolved sourceUri does not exist on disk: ${resolved}`);
    }

    // Copy into the canonical MODEL_PATH so anyone bypassing the
    // registry (or restarting cold) still gets the correct artefact.
    // Atomic rename so an in-flight predict never observes a half-
    // written file.
    if (resolved !== this.modelPath) {
      const tempPath = `${this.modelPath}.tmp`;
      fs.copyFileSync(resolved, tempPath);
      fs.renameSync(tempPath, this.modelPath);
    }

    await this.loadModel();
    onnxLogger.success("applyActiveVersion", "Hot-reloaded ACTIVE model", {
      sourceUri,
      modelPath: this.modelPath,
    });
  }

  /**
   * Tear down listeners. Exposed so server-shutdown hooks can call it
   * cleanly; safe to call multiple times.
   */
  close(): void {
    if (this.unsubscribeActiveChange) {
      this.unsubscribeActiveChange();
      this.unsubscribeActiveChange = null;
    }
  }

  /**
   * Run inference on feature vector using circuit breaker.
   * Vector width is determined by the active feature catalogue
   * (64 base + adopter overlay). Pad-to-fit handles models trained
   * against a wider dimension via `MODEL_INPUT_DIMENSION`.
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

      // Pad-to-fit if the loaded model expects more dimensions than
      // the catalogue currently produces. Only used for the brief
      // transition between Phase 2 (RDA serves 64-dim) and Phase 3
      // (MLA retrains at 64-dim). When the model and catalogue match,
      // `features` is used verbatim.
      const expectedDim = Number(process.env.MODEL_INPUT_DIMENSION) || 0;
      let inputArray = features;
      if (expectedDim > features.length) {
        inputArray = new Float32Array(expectedDim);
        inputArray.set(features);
      }

      // Create input tensor
      const inputTensor = new ort.Tensor("float32", inputArray, [1, inputArray.length]);

      // Run inference
      const feeds = { input: inputTensor };
      const results = await this.session.run(feeds);

      // Extract probability from output
      const output = results.output || results.probabilities || Object.values(results)[0];
      if (!output) throw new Error("ONNX inference returned no output tensor");
      const probability = (output.data as Float32Array)[0]!;

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
   * Heuristic fallback used when no ONNX model is loaded (dev / first
   * boot before MLA registers an artefact). Reads positions defined by
   * the base catalogue in `models/feature-catalog.v1.json`.
   */
  private mockInference(features: Float32Array): number {
    // Catalogue base layout: 0=velocity_1h, 1=velocity_24h, 2=velocity_7d,
    // 3=amount_mean_30d, 5=graph_pagerank, and `amount` lives in the
    // transaction block. See models/feature-catalog.v1.json for the
    // authoritative index map.
    const velocity1h = features[0] || 0;
    const velocity24h = features[1] || 0;
    const avgAmount30d = features[3] || 0;
    const pagerank = features[5] || 0;
    const amount = features[10] || 0;

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
   * Check if a real ONNX session is loaded. Previously this returned
   * `true` even in mock-inference mode (the expression evaluated to
   * `true` whenever the model failed to load), so `/readyz` reported
   * green while predictions were random-noise — which is the worst
   * possible failure mode for a fraud system. Mock mode now reports
   * NOT ready; the surrounding boot flow still serves degraded
   * default-feature predictions, but operators get an unmissable
   * "fix me" signal from the health probe.
   */
  isReady(): boolean {
    return this.session !== null;
  }

  /**
   * Get model info
   */
  getModelInfo(): { path: string; loaded: boolean; inputDimensions: number } {
    const expectedDim = Number(process.env.MODEL_INPUT_DIMENSION) || 0;
    return {
      path: this.modelPath,
      loaded: this.isModelLoaded,
      inputDimensions: expectedDim,
    };
  }
}

export default OnnxService;
