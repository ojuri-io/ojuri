import { singleton } from "tsyringe";
import { createServiceLogger } from "@shared/utils/logger/service-logger";
import appConfig from "@config/app.config";
import ModelVersionRepo from "./repositories/model-version.repo";
import SegmentThresholdRepo from "./repositories/segment-threshold.repo";
import { ModelVersion } from "./model/model-version.model";

const log = createServiceLogger("ModelRegistry");

const REFRESH_INTERVAL_MS = Number(process.env.MODEL_REGISTRY_REFRESH_MS) || 30_000;

export type ModelStatus = "CANDIDATE" | "SHADOW" | "ACTIVE" | "RETIRED";

export type ModelVersionRecord = ModelVersion;

export interface ResolvedDecisionContext {
  championVersion: string;
  shadowVersion: string | null;
  threshold: number;
}

/**
 * Caches the active champion, optional shadow, and per-segment
 * thresholds; refreshes from Postgres every 30 s. Falls back to
 * the env-configured `FRAUD_THRESHOLD` and a synthetic version
 * label when the DB is empty (i.e. the first run before anyone
 * registers a real model).
 */
type ActiveChangeListener = (current: ModelVersion | null, previous: ModelVersion | null) => void;

@singleton()
class ModelRegistryService {
  private champion: ModelVersion | null = null;
  private shadow: ModelVersion | null = null;
  private thresholdsBySegment: Map<string, Map<string, number>> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private loaded = false;
  // Listeners notified when the ACTIVE model row changes (different
  // version label or different sourceUri). OnnxService subscribes so
  // it can hot-swap the loaded model without RDA restart.
  private activeChangeListeners: ActiveChangeListener[] = [];

  constructor(
    private readonly versionRepo: ModelVersionRepo,
    private readonly thresholdRepo: SegmentThresholdRepo
  ) {}

  /**
   * Subscribe to ACTIVE-version changes. Called with `(current,
   * previous)` whenever a reload finds a different ACTIVE row from
   * the cached one. `previous` is `null` on the first ACTIVE seen
   * after startup. Returns an unsubscribe function.
   */
  onActiveChange(fn: ActiveChangeListener): () => void {
    this.activeChangeListeners.push(fn);
    return () => {
      this.activeChangeListeners = this.activeChangeListeners.filter((l) => l !== fn);
    };
  }

  async initialize(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => {
      this.reload().catch((err) =>
        log.error("reload", "Failed to refresh model registry", { err: String(err) })
      );
    }, REFRESH_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  async reload(): Promise<void> {
    const [versions, thresholds] = await Promise.all([
      this.versionRepo.listAll(),
      this.thresholdRepo.listActive(),
    ]);

    const previousChampion = this.champion;
    this.champion = versions.find((v) => v.status === "ACTIVE") || null;
    this.shadow = versions.find((v) => v.status === "SHADOW") || null;

    // Detect "ACTIVE changed" via version label OR sourceUri delta —
    // both matter because operators can re-register the same version
    // pointing at a different artefact path.
    const changed =
      previousChampion?.version !== this.champion?.version ||
      previousChampion?.sourceUri !== this.champion?.sourceUri;
    if (changed && this.activeChangeListeners.length > 0) {
      const current = this.champion;
      for (const listener of this.activeChangeListeners) {
        try {
          listener(current, previousChampion);
        } catch (err) {
          log.error("activeChange", "Listener threw — continuing", { err: String(err) });
        }
      }
    }

    const segMap = new Map<string, Map<string, number>>();
    for (const t of thresholds) {
      let inner = segMap.get(t.segment);
      if (!inner) {
        inner = new Map();
        segMap.set(t.segment, inner);
      }
      inner.set(t.modelVersion, Number(t.threshold));
    }
    this.thresholdsBySegment = segMap;
    this.loaded = true;

    log.debug("reload", "Registry refreshed", {
      champion: this.champion?.version,
      shadow: this.shadow?.version,
      thresholds: thresholds.length,
    });
  }

  /**
   * Resolve the decision context for an incoming request. Returns
   * the champion version label, the optional shadow label, and the
   * effective threshold for the given segment.
   */
  resolve(segment: string | undefined): ResolvedDecisionContext {
    const championVersion =
      this.champion?.version || process.env.MODEL_VERSION_LABEL || "default";
    const shadowVersion = this.shadow?.version || null;

    const segmentThresholds = segment ? this.thresholdsBySegment.get(segment) : undefined;
    const segmentSpecific = segmentThresholds?.get(championVersion);

    const threshold =
      segmentSpecific ?? this.champion?.defaultThreshold ?? appConfig.fraud.threshold;

    return { championVersion, shadowVersion, threshold };
  }

  async register(input: {
    version: string;
    sourceUri: string;
    sha256?: string;
    defaultThreshold?: number;
    metrics?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<ModelVersion> {
    const row = await this.versionRepo.save({
      version: input.version,
      sourceUri: input.sourceUri,
      sha256: input.sha256 ?? null,
      status: "CANDIDATE",
      defaultThreshold: input.defaultThreshold ?? appConfig.fraud.threshold,
      metrics: input.metrics ?? null,
      metadata: input.metadata ?? null,
    });
    await this.reload();
    return row;
  }

  async setStatus(version: string, status: ModelStatus): Promise<ModelVersion | null> {
    const row = await this.versionRepo.transitionStatus(version, status);
    await this.reload();
    return row || null;
  }

  async list(): Promise<ModelVersion[]> {
    return this.versionRepo.listOrdered();
  }

  /**
   * All segment-threshold rows. The admin UI's Models page renders
   * these in a per-segment table; only the active set is consulted on
   * the prediction hot path.
   */
  async listSegmentThresholds() {
    return this.thresholdRepo.listAll();
  }

  /**
   * Patch mutable fields on an existing model record without
   * re-registering. Useful for nudging a threshold in production
   * without a deploy, or for backfilling `metrics` after an
   * offline backtest.
   */
  async update(
    version: string,
    patch: { defaultThreshold?: number; metrics?: Record<string, unknown>; metadata?: Record<string, unknown> }
  ): Promise<ModelVersion | null> {
    const row = await this.versionRepo.update(version, patch);
    await this.reload();
    return row || null;
  }

  async setSegmentThreshold(input: {
    segment: string;
    modelVersion: string;
    threshold: number;
  }): Promise<void> {
    await this.thresholdRepo.upsert(input);
    await this.reload();
  }

  /**
   * Hard-delete a model version. The on-disk artefacts (resolved from
   * the row's `sourceUri`) are removed before the row to avoid an
   * orphaned blob if the DB write fails. Refuses ACTIVE / SHADOW —
   * callers must transition the model to RETIRED first.
   *
   * Returns true if a row was deleted, false if the version didn't
   * exist. Throws when the version is still ACTIVE / SHADOW.
   */
  async deleteVersion(version: string): Promise<boolean> {
    const row = await this.versionRepo.findByVersion(version);
    if (!row) return false;
    if (row.status === "ACTIVE" || row.status === "SHADOW") {
      throw new Error(
        `Cannot delete ${row.status} model '${version}' — retire it first via POST /v1/admin/models/${version}/status`
      );
    }

    // Best-effort filesystem cleanup. `sourceUri` is a relative path
    // (e.g. "models/versions/v1.2.0/model.onnx") — the version's
    // sibling artefacts (scaler.npz, meta.json) live in the same
    // directory, so we remove the directory if it's under models/.
    const path = await import("path");
    const fs = await import("fs/promises");
    try {
      const resolved = this.resolveLocalPath(row.sourceUri);
      if (resolved && resolved.includes(path.sep + "models" + path.sep + "versions" + path.sep)) {
        const dir = path.dirname(resolved);
        await fs.rm(dir, { recursive: true, force: true });
        log.info("deleteVersion", "Removed model directory", { version, dir });
      }
    } catch (err) {
      // Don't abort the DB delete on filesystem errors — operators
      // can clean up stale dirs manually if needed.
      log.warn("deleteVersion", "Filesystem cleanup failed", {
        version,
        err: String(err),
      });
    }

    await this.versionRepo.deleteByVersion(version);
    await this.reload();
    return true;
  }

  /**
   * Resolve a `sourceUri` to an absolute filesystem path. Supports
   * `file://...` URLs and bare relative paths. Anything else
   * (s3://, http://) returns null — caller should treat that as
   * "not a local artefact, can't manage on disk".
   */
  resolveLocalPath(sourceUri: string | null | undefined): string | null {
    if (!sourceUri) return null;
    const path = require("path") as typeof import("path");
    if (sourceUri.startsWith("file://")) {
      return sourceUri.slice("file://".length);
    }
    if (sourceUri.startsWith("/")) return sourceUri;
    if (/^[a-z]+:\/\//i.test(sourceUri)) return null; // remote scheme
    return path.resolve(process.cwd(), sourceUri);
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getChampion(): ModelVersion | null {
    return this.champion;
  }

  getShadow(): ModelVersion | null {
    return this.shadow;
  }
}

export default ModelRegistryService;
