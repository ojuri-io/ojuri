import { GroundTruthSource } from "@shared/enums/ground-truth-source.enum";

export interface LabelDto {
  transaction_id: string;
  is_fraud: boolean;
  source: GroundTruthSource;
}

export interface IngestLabelsRequestDto {
  labels: LabelDto[];
}

export interface IngestLabelsResponseDto {
  received: number;
  applied: number;
  unmatched: string[];
}
