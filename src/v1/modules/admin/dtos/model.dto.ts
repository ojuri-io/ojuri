import { ModelStatus } from "@shared/models/model-registry.service";

export interface RegisterModelDto {
  version: string;
  sourceUri: string;
  sha256?: string;
  defaultThreshold?: number;
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpdateModelDto {
  defaultThreshold?: number;
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SetModelStatusDto {
  status: ModelStatus;
}

export interface SetSegmentThresholdDto {
  segment: string;
  modelVersion: string;
  threshold: number;
}
