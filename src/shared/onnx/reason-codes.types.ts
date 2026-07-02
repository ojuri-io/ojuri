export interface ReasonCode {
  code: string;
  description: string;
  contribution: number;
  value: number;
}

export interface ReasonFeatureSpec {
  feature: string;
  code: string;
  description: string;
  baseline: number;
  scale: number;
  weight: number;
}
