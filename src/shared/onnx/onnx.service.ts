import * as ort from "onnxruntime-node";
import { container, singleton } from "tsyringe";
import appConfig from "@config/app.config";
import { createServiceLogger, TraceContext } from "@shared/utils/logger/service-logger";
import { metricsService } from "@shared/metrics/metrics.service";
import { createCircuitBreaker } from "@shared/circuit-breaker/circuit-breaker";
import type CircuitBreaker from "opossum";
import type { ModelVersion } from "@shared/models/model/model-version.model";
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
  // Pool of identical ONNX InferenceSession instances. onnxruntime-node
  // serializes concurrent `session.run` calls at the session level, so a
  // single shared session caps inference parallelism at one in-flight call
  // regardless of CPU count. Pooling N sessions and round-robin'ing across
  // them removes that ceiling. The model is loaded into each session, so
  // total memory cost scales linearly with pool size — bound the pool
  // (default ceil(cpus/2), capped at 8) and document the tradeoff for
  // operators deploying multi-GB models.
  private sessions: ort.InferenceSession[] = [];
  private nextSessionIndex = 0;
  // Shadow model pool — small (2 sessions max): shadow scoring is
  // observational, so a little serialization is an acceptable trade
  // against doubling model memory.
  private shadowSessions: ort.InferenceSession[] = [];
  private nextShadowIndex = 0;
  private shadowSourceKey: string | null = null;
  private modelPath: string;
  private inferenceCircuitBreaker!: CircuitBreaker<any[], any>;
  private isModelLoaded: boolean = false;
  private isCalibrationHealthy: boolean = false;
  private unsubscribeActiveChange: (() => void) | null = null;

  constructor() {
    this.modelPath = path.resolve(appConfig.onnx.modelPath);
    this.setupCircuitBreaker();
  }

  private nextSession(): ort.InferenceSession {
    const len = this.sessions.length;
    const idx = this.nextSessionIndex % len;
    this.nextSessionIndex = (this.nextSessionIndex + 1) % len;
    return this.sessions[idx]!;
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
      await this.runCalibrationProbe();
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
   * Sanity-probe the loaded model right after `loadModel()`. Catches
   * two failure modes that previously slipped past every health check:
   *
   * 1. mockInference fallback — happens when `session` is null or
   *    when an earlier OnnxService init never ran. mockInference adds
   *    `Math.random() * 0.05`, so two identical inputs produce
   *    different scores. The determinism check fails.
   *
   * 2. Constant or near-constant model — happens when training was
   *    misconfigured (feature-ordering bug, label-leak, wrong loss).
   *    A clearly-legit vs clearly-fraud input pair should differ by
   *    at least `MIN_DISCRIMINATION_GAP`. If both score the same the
   *    model has no signal and we'd rather refuse traffic than serve
   *    coin-flip predictions.
   *
   * Either failure marks the service NOT ready; `/readyz` will return
   * DOWN until a working model replaces the bad one.
   */
  private async runCalibrationProbe(): Promise<void> {
    if (this.sessions.length === 0 || !this.isModelLoaded) {
      this.isCalibrationHealthy = false;
      onnxLogger.error("calibrationProbe", "No ONNX sessions loaded — skipping probe (service will report NOT ready)", {});
      return;
    }

    const MIN_DISCRIMINATION_GAP = 0.15;
    const DETERMINISM_TOLERANCE = 1e-4;

    try {
      // Clearly-legit: trusted device, mature account, domestic, long session.
      const legitVec = this.buildProbeVector({ fraud: false });
      // Clearly-fraud: VPN, new account, foreign IP, 1-second session.
      const fraudVec = this.buildProbeVector({ fraud: true });

      const [legit1, legit2, fraud1, fraud2] = await Promise.all([
        this.runRawInference(legitVec),
        this.runRawInference(legitVec),
        this.runRawInference(fraudVec),
        this.runRawInference(fraudVec),
      ]);

      const legitJitter = Math.abs(legit1 - legit2);
      const fraudJitter = Math.abs(fraud1 - fraud2);
      const gap = fraud1 - legit1;

      const isDeterministic = legitJitter < DETERMINISM_TOLERANCE && fraudJitter < DETERMINISM_TOLERANCE;
      const discriminates = gap >= MIN_DISCRIMINATION_GAP;

      if (!isDeterministic) {
        onnxLogger.error(
          "calibrationProbe",
          "Model output is non-deterministic — identical inputs produced different scores. " +
            "This is the signature of the mockInference fallback. /readyz will report DOWN.",
          { legitJitter, fraudJitter, tolerance: DETERMINISM_TOLERANCE }
        );
        this.isCalibrationHealthy = false;
        return;
      }
      if (!discriminates) {
        onnxLogger.error(
          "calibrationProbe",
          "Model fails to discriminate between clearly-legit and clearly-fraud inputs. " +
            `Score gap ${gap.toFixed(4)} is below the ${MIN_DISCRIMINATION_GAP} threshold. ` +
            "Model is constant or near-constant — /readyz will report DOWN.",
          { legitScore: legit1, fraudScore: fraud1, gap }
        );
        this.isCalibrationHealthy = false;
        return;
      }

      this.isCalibrationHealthy = true;
      onnxLogger.success("calibrationProbe", "Model passed calibration", {
        legitScore: legit1,
        fraudScore: fraud1,
        gap: Number(gap.toFixed(4)),
      });
    } catch (err) {
      onnxLogger.error("calibrationProbe", "Probe threw — marking model NOT ready", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.isCalibrationHealthy = false;
    }
  }

  /**
   * Build a 64-dim probe vector at catalogue positions. The values are
   * chosen to be unambiguously legit or fraud along several axes any
   * sensibly-trained model picks up — small amount + authenticated +
   * trusted device + mature account + domestic for legit; vice versa
   * for fraud. The vector itself never enters production; it's used
   * only inside the calibration probe.
   */
  private buildProbeVector(opts: { fraud: boolean }): Float32Array {
    const dim = Number(process.env.MODEL_INPUT_DIMENSION) || 64;
    const v = new Float32Array(dim);
    if (opts.fraud) {
      v[26] = 850000;   // amount
      v[28] = 4;        // transaction_type_code (CASH_OUT-ish)
      v[31] = 0;        // is_inflow=false
      v[35] = 1;        // account_age_days=1
      v[39] = 0;        // is_authenticated=false
      v[52] = 1;        // ip_is_vpn=true
      v[53] = 0;        // device_is_trusted=false
      v[57] = 1;        // session_to_txn_seconds=1
    } else {
      v[26] = 42.5;     // amount
      v[28] = 2;        // transaction_type_code (PAYMENT-ish)
      v[31] = 0;        // is_inflow
      v[35] = 730;      // account_age_days
      v[39] = 1;        // is_authenticated=true
      v[52] = 0;        // ip_is_vpn=false
      v[53] = 1;        // device_is_trusted=true
      v[57] = 180;      // session_to_txn_seconds
    }
    return v;
  }

  /**
   * Bypass the circuit breaker for the calibration probe. Going through
   * `predict()` would route through opossum and either get classified
   * as a failure or get the 1.0 fail-closed fallback — neither is what
   * we want at probe time.
   */
  private async runRawInference(features: Float32Array): Promise<number> {
    return this.runInference(features);
  }

  /**
   * Load ONNX model from disk
   */
  private async loadModel(): Promise<void> {
    const startTime = Date.now();

    try {
      if (!fs.existsSync(this.modelPath)) {
        onnxLogger.error(
          "loadModel",
          "Model file not found — train a model with " +
            "`cd mla-service && source venv/bin/activate && python scripts/train_initial_model.py` " +
            "then copy the resulting .onnx to models/fraud_model.onnx. " +
            "RDA will not accept traffic until /readyz reports onnx-model: UP.",
          { modelPath: this.modelPath }
        );
        this.sessions = [];
        this.isModelLoaded = false;
        return;
      }

      // Per-session intra-op thread count is deliberately constrained so a
      // pool of N sessions does not oversubscribe the host's CPUs. For the
      // 122 KB XGBoost model we ship by default, tree traversal is
      // inherently single-threaded, so 1 thread per session is optimal.
      const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: ["cpu"],
        graphOptimizationLevel: "all",
        enableCpuMemArena: true,
        enableMemPattern: true,
        executionMode: "sequential",
        intraOpNumThreads: appConfig.onnx.intraOpNumThreads,
      };

      const poolSize = appConfig.onnx.sessionPoolSize;
      const newSessions = await Promise.all(
        Array.from({ length: poolSize }, () =>
          ort.InferenceSession.create(this.modelPath, sessionOptions),
        ),
      );

      // Atomic swap so an in-flight predict either sees the old pool or
      // the new pool, never a partially-initialised array. The previous
      // sessions become unreachable and are GC'd once their in-flight
      // calls drain.
      this.sessions = newSessions;
      this.nextSessionIndex = 0;
      this.isModelLoaded = true;

      const loadTime = Date.now() - startTime;
      metricsService.recordModelLoadTime(loadTime);
      metricsService.recordOnnxPoolSize(poolSize);

      onnxLogger.success("loadModel", "ONNX model loaded successfully", {
        loadTime,
        modelPath: this.modelPath,
        poolSize,
        intraOpNumThreads: appConfig.onnx.intraOpNumThreads,
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

      registry.onShadowChange((current, previous) => {
        onnxLogger.info("shadowChange", "SHADOW model version changed", {
          from: previous?.version ?? "(none)",
          to: current?.version ?? "(none)",
        });
        this.applyShadowVersion(current).catch((err) =>
          onnxLogger.error("applyShadowVersion", "Failed to load SHADOW model", {
            version: current?.version ?? null,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      });

      // The registry initializes before OnnxService, so a shadow that
      // was already SHADOW at boot never fires the change listener.
      await this.applyShadowVersion(registry.getShadow()).catch((err) =>
        onnxLogger.error("applyShadowVersion", "Failed initial SHADOW load", {
          error: err instanceof Error ? err.message : String(err),
        })
      );
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

    const resolved = this.resolveSourceUri(sourceUri);
    if (!resolved) {
      onnxLogger.warn("applyActiveVersion", "Non-local sourceUri scheme — skipping hot-reload", {
        sourceUri,
      });
      return;
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
    // Re-probe after every hot-swap. A model that loads at the ONNX-runtime
    // level can still be wrong-dim, constant, or inverted at the prediction
    // level — without this the registry could swap in a broken artefact and
    // /readyz would stay UP while every predict returns the fail-closed 1.0.
    await this.runCalibrationProbe();
    onnxLogger.success("applyActiveVersion", "Hot-reloaded ACTIVE model", {
      sourceUri,
      modelPath: this.modelPath,
      calibrationHealthy: this.isCalibrationHealthy,
    });
  }

  private resolveSourceUri(sourceUri: string): string | null {
    if (sourceUri.startsWith("file://")) return sourceUri.slice("file://".length);
    if (sourceUri.startsWith("/")) return sourceUri;
    if (/^[a-z]+:\/\//i.test(sourceUri)) return null;
    return path.resolve(process.cwd(), sourceUri);
  }

  /**
   * Load (or unload) the SHADOW model's sessions. Loaded directly from
   * the version's artefact path — the canonical MODEL_PATH stays owned
   * by the champion. A shadow that fails to load leaves shadow scoring
   * off (`predictShadow` returns null); it never affects the decision
   * path or /readyz.
   */
  private async applyShadowVersion(row: ModelVersion | null): Promise<void> {
    if (!row || !row.sourceUri) {
      if (this.shadowSessions.length > 0) {
        onnxLogger.info("applyShadowVersion", "Shadow cleared — unloading sessions", {});
      }
      this.shadowSessions = [];
      this.shadowSourceKey = null;
      return;
    }

    const key = `${row.version}|${row.sourceUri}`;
    if (key === this.shadowSourceKey) return;

    const metadata = row.metadata as Record<string, unknown> | null;
    if (metadata && typeof metadata.feature_schema_version === "string") {
      const { loadCatalog } = await import("@shared/features/feature-catalog");
      const expected = loadCatalog().schemaVersion;
      if (metadata.feature_schema_version !== expected) {
        onnxLogger.error("applyShadowVersion", "Refusing shadow — feature schema mismatch", {
          version: row.version,
          reported: metadata.feature_schema_version,
          expected,
        });
        this.shadowSessions = [];
        this.shadowSourceKey = null;
        return;
      }
    }

    const resolved = this.resolveSourceUri(row.sourceUri);
    if (!resolved || !fs.existsSync(resolved)) {
      onnxLogger.error("applyShadowVersion", "Shadow sourceUri not loadable", {
        version: row.version,
        sourceUri: row.sourceUri,
      });
      this.shadowSessions = [];
      this.shadowSourceKey = null;
      return;
    }

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true,
      executionMode: "sequential",
      intraOpNumThreads: appConfig.onnx.intraOpNumThreads,
    };
    const poolSize = Math.min(2, appConfig.onnx.sessionPoolSize);
    const newSessions = await Promise.all(
      Array.from({ length: poolSize }, () => ort.InferenceSession.create(resolved, sessionOptions)),
    );

    this.shadowSessions = newSessions;
    this.nextShadowIndex = 0;
    this.shadowSourceKey = key;
    onnxLogger.success("applyShadowVersion", "SHADOW model loaded", {
      version: row.version,
      sourceUri: row.sourceUri,
      poolSize,
    });
  }

  /**
   * Score the SHADOW model. Observational only: returns null when no
   * shadow is loaded or scoring fails — never throws, never fails
   * closed, never touches the decision.
   */
  async predictShadow(features: Float32Array): Promise<number | null> {
    if (this.shadowSessions.length === 0) return null;

    const session = this.shadowSessions[this.nextShadowIndex % this.shadowSessions.length]!;
    this.nextShadowIndex = (this.nextShadowIndex + 1) % this.shadowSessions.length;

    const startTime = Date.now();
    try {
      const score = await this.executeSession(session, features);
      metricsService.recordPredictStage("shadow_inference", Date.now() - startTime);
      return score;
    } catch (err) {
      onnxLogger.warn("predictShadow", "Shadow inference failed — recording null", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  isShadowLoaded(): boolean {
    return this.shadowSessions.length > 0;
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
      if (this.sessions.length === 0 || !this.isModelLoaded) {
        throw new Error("ONNX sessions not loaded — predict cannot proceed");
      }

      // The pool selector spreads concurrent calls across sessions so
      // onnxruntime-node's per-session execution lock does not
      // serialize the request hot path.
      const probability = await this.executeSession(this.nextSession(), features);

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

  private async executeSession(
    session: ort.InferenceSession,
    features: Float32Array
  ): Promise<number> {
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

    const inputTensor = new ort.Tensor("float32", inputArray, [1, inputArray.length]);
    const results = await session.run({ input: inputTensor });

    // XGBoost-via-onnxmltools emits `probabilities` shape [N, 2] as
    // [P(legit), P(fraud)] — we need index 1. Legacy single-output
    // stubs still expose a scalar at index 0.
    const output: ort.Tensor =
      (results.probabilities as ort.Tensor | undefined) ??
      (results.output as ort.Tensor | undefined) ??
      (Object.values(results)[0] as ort.Tensor);
    if (!output) throw new Error("ONNX inference returned no output tensor");
    const data = output.data as Float32Array;
    const dims = output.dims ?? [];
    const isBinaryProbs = dims.length === 2 && dims[1] === 2 && data.length >= 2;
    return isBinaryProbs ? data[1]! : data[0]!;
  }

  /**
   * Removed. The previous heuristic fallback produced plausible-looking
   * but meaningless scores when no model was loaded, silently masking
   * the four bugs that motivated the open-source-readiness work. The
   * predict path now hard-fails when the session is null; the circuit
   * breaker returns the existing 1.0 (DECLINE) and /readyz reports
   * onnx-model: DOWN via the calibration probe.
   */

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
    return this.sessions.length > 0 && this.isCalibrationHealthy;
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
