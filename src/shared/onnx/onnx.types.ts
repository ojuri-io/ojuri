export interface InferenceOutcome {
  score: number;
  calibratedScore: number | null;
  degraded: boolean;
}

export interface CalibrationSpec {
  xThresholds: number[];
  yThresholds: number[];
}

export enum CalibrationMode {
  OBSERVE = "observe",
  ENFORCE = "enforce",
}
