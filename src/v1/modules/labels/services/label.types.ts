import { LabelDto } from "../dtos/label.dto";

export interface LabelBatchValidation {
  labels: LabelDto[];
  errors: string[];
}

export interface LabelWriter {
  applyLabels(labels: LabelDto[], recordedBy: string): Promise<string[]>;
}
