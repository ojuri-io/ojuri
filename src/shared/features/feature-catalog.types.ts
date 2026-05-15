/**
 * Feature catalogue types — shared between RDA's enrichment pipeline,
 * MLA's training preprocessor (via the Python mirror), and PAA's Redis
 * writer. The catalogue is the single source of truth for the model's
 * input vector shape and the meaning of every index.
 *
 * The base catalogue is the immutable `models/feature-catalog.v1.json`
 * shipped with the repo. Adopters extend with
 * `models/feature-catalog.adopter.json` for indices 64+.
 */

/**
 * Where a feature value comes from. Used by RDA's enrichment pipeline
 * to know which source to consult; used by MLA's preprocessor to know
 * which column of the training frame to map into a given index.
 */
export type FeatureSource =
  /** Direct field from the `POST /v1/predict` body. */
  | "rda:request"
  /**
   * Computed by RDA from one or more request fields (or by reading a
   * lookup table shipped under `models/lookups/`). RDA's
   * `feature.service.ts` is responsible.
   */
  | "rda:derived"
  /**
   * Pulled from Redis under `features:{senderId}` (or
   * `features:{receiverId}` for receiver-keyed features). Written by
   * PAA's `redis-update.service.ts` after consuming a Kafka event.
   */
  | "paa:redis"
  /**
   * Looked up from a static config table at boot. Never per-request.
   */
  | "config:lookup";

export type FeatureDtype = "float32" | "uint8" | "bool";

export type FeatureCategory =
  | "velocity"
  | "pair"
  | "graph"
  | "transaction"
  | "identity"
  | "receiver"
  | "geographic"
  | "device"
  | "calendar"
  | "adopter";

/**
 * One row in the catalogue. Each `index` is a column of the ONNX input
 * tensor — `index` values across base + adopter overlay MUST be
 * contiguous starting from 0.
 */
export interface FeatureSpec {
  index: number;
  name: string;
  category: FeatureCategory;
  source: FeatureSource;
  dtype: FeatureDtype;
  default: number | boolean;
  description: string;
  /**
   * Only valid on adopter-overlay features. The base catalogue's
   * features all have hand-written enrichment code on the RDA side, so
   * no declarative compute is needed. See `docs/FEATURES.md` for the
   * supported `compute.type` reference.
   */
  compute?: ComputeOp;
}

export type ComputeOp =
  | { type: "from_field"; field: string }
  | { type: "equals"; field: string; value: string | number | boolean }
  | { type: "not_equals"; field: string; value: string | number | boolean }
  | { type: "is_one_of"; field: string; values: (string | number)[] }
  | {
      type: "ratio";
      numerator: { field: string };
      denominator: { field: string };
      min_denominator?: number;
    }
  | {
      type: "lookup";
      field: string;
      /** Path relative to `models/lookups/`. */
      table: string;
      default?: number | string;
    }
  | {
      type: "numeric_bucket";
      field: string;
      /** Bucket boundaries, inclusive of the upper bound. */
      boundaries: number[];
    }
  | { type: "bool_and"; refs: string[] }
  | { type: "bool_or"; refs: string[] }
  | { type: "from_redis"; key: string }
  /**
   * Delegate to a code-based resolver registered via
   * `registerCustomFeature(name, fn)` (TS) and
   * `register_custom_feature(name, fn)` (Python). Use this when the
   * declarative algebra above can't express the feature — e.g. a
   * lookup against an external service, a multi-field heuristic that
   * mixes Redis + request + a lookup table, or anything that needs
   * conditional control flow.
   *
   * Parity is the adopter's responsibility: both the RDA-side and
   * MLA-side resolver must produce the same value for the same
   * inputs. If they drift, the `feature_schema_version` mechanism
   * won't catch it (the catalogue file is identical) — write a
   * unit test that pins the contract.
   */
  | { type: "custom"; resolver: string };

export interface FeatureCatalogFile {
  version: string;
  input_dimension: number;
  description?: string;
  features: FeatureSpec[];
}

export interface AdopterOverlayFile {
  extends: string;
  description?: string;
  features: FeatureSpec[];
}

/**
 * The merged, validated catalogue exposed to the rest of the codebase.
 * `schemaVersion` embeds both the base version and a SHA of the
 * adopter overlay so RDA can refuse to load a model trained against a
 * different overlay (the silent train/serve-skew class).
 */
export interface ResolvedCatalog {
  baseVersion: string;
  /** "v1" or "v1+adopter:<sha256-prefix>" — written into every trained model's metadata. */
  schemaVersion: string;
  inputDimension: number;
  features: readonly FeatureSpec[];
  /** Index → spec lookup. */
  byIndex: ReadonlyMap<number, FeatureSpec>;
  /** Name → spec lookup. */
  byName: ReadonlyMap<string, FeatureSpec>;
  /** Adopter SHA-256 (hex) or null when no overlay is in effect. */
  adopterSha256: string | null;
}
