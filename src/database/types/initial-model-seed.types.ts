import { ModelStatus } from "../../shared/enums/model-status.enum";

export interface InitialModelSeedEntry {
  version: string;
  sourceUri: string;
  sha256: string;
  status: ModelStatus;
  defaultThreshold: number;
  metadata: InitialModelSeedMetadata;
}

export interface InitialModelSeedMetadata {
  feature_schema_version: string;
  feature_input_dimension: number;
  seeded_at: string;
  is_initial_model: true;
}
