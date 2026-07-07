import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Knex } from "knex";
import { DB_TABLES } from "../../shared/enums/db-tables.enum";
import { InitialModelSeedEntry } from "../types/initial-model-seed.types";

// "default" on purpose: the response's model_version keeps signalling
// "shipped demo model" on a fresh install, and v1.x stays reserved for
// adopter-trained models (MLA's first train also labels itself v1.0).
const VERSION_LABEL = process.env.SEED_INITIAL_MODEL_VERSION ?? "default";
const MODEL_RELATIVE_PATH = process.env.SEED_INITIAL_MODEL_PATH ?? "models/fraud_model.onnx";
const CATALOG_RELATIVE_PATH = "models/feature-catalog.v1.json";
const DEFAULT_THRESHOLD = 0.65;

function resolveAlongsideCwd(relative: string): string {
  if (path.isAbsolute(relative)) return relative;
  return path.resolve(process.cwd(), relative);
}

function readSchemaVersion(): { schemaVersion: string; inputDimension: number } | null {
  const catalogPath = resolveAlongsideCwd(CATALOG_RELATIVE_PATH);
  if (!fs.existsSync(catalogPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (typeof parsed?.version !== "string") return null;
  if (typeof parsed?.input_dimension !== "number") return null;
  return { schemaVersion: parsed.version, inputDimension: parsed.input_dimension };
}

function sha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export async function seed(knex: Knex): Promise<void> {
  const modelPath = resolveAlongsideCwd(MODEL_RELATIVE_PATH);
  if (!fs.existsSync(modelPath)) {
    // Adopters without a shipped artefact register their own via
    // POST /v1/admin/models — see docs/TRAINING.md. We deliberately
    // do not fail the seed run here.
    console.warn(
      `[00_initial_model_version] skipping — ${MODEL_RELATIVE_PATH} not found on disk. ` +
        `Register a model via POST /v1/admin/models or set SEED_INITIAL_MODEL_PATH.`
    );
    return;
  }

  const catalog = readSchemaVersion();
  if (!catalog) {
    console.warn(
      `[00_initial_model_version] skipping — ${CATALOG_RELATIVE_PATH} not parseable. ` +
        `Feature schema must be known before registering a model.`
    );
    return;
  }

  const existing = await knex(DB_TABLES.MODEL_VERSIONS)
    .where({ status: "ACTIVE" })
    .first("version");
  if (existing && existing.version !== VERSION_LABEL) {
    console.warn(
      `[00_initial_model_version] skipping — '${existing.version}' is already ACTIVE; ` +
        `not overwriting an operator-promoted model.`
    );
    return;
  }

  const entry: InitialModelSeedEntry = {
    version: VERSION_LABEL,
    sourceUri: MODEL_RELATIVE_PATH,
    sha256: sha256(modelPath),
    status: "ACTIVE",
    defaultThreshold: DEFAULT_THRESHOLD,
    metadata: {
      feature_schema_version: catalog.schemaVersion,
      feature_input_dimension: catalog.inputDimension,
      seeded_at: new Date().toISOString(),
      is_initial_model: true,
    },
  };

  await knex(DB_TABLES.MODEL_VERSIONS)
    .insert({
      version: entry.version,
      sourceUri: entry.sourceUri,
      sha256: entry.sha256,
      status: entry.status,
      defaultThreshold: entry.defaultThreshold,
      metadata: JSON.stringify(entry.metadata),
      activatedAt: knex.fn.now(),
    })
    .onConflict("version")
    .merge({
      sourceUri: entry.sourceUri,
      sha256: entry.sha256,
      status: entry.status,
      defaultThreshold: entry.defaultThreshold,
      metadata: JSON.stringify(entry.metadata),
      activatedAt: knex.fn.now(),
      updatedAt: knex.fn.now(),
    });
}
