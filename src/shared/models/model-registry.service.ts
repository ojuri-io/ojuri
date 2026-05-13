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
@singleton()
class ModelRegistryService {
  private champion: ModelVersion | null = null;
  private shadow: ModelVersion | null = null;
  private thresholdsBySegment: Map<string, Map<string, number>> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private loaded = false;

  constructor(
    private readonly versionRepo: ModelVersionRepo,
    private readonly thresholdRepo: SegmentThresholdRepo
  ) {}

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

    this.champion = versions.find((v) => v.status === "ACTIVE") || null;
    this.shadow = versions.find((v) => v.status === "SHADOW") || null;

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
