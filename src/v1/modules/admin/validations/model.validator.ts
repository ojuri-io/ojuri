export const registerModelValidationRules = {
  version: "required|string|min:1|max:100",
  sourceUri: "required|string|min:1|max:1024",
  sha256: "string|max:128",
  defaultThreshold: "numeric|min:0|max:1",
};

export const registerModelValidationMessages = {
  "version.required": "version is required",
  "sourceUri.required": "sourceUri is required",
  "defaultThreshold.min": "defaultThreshold must be in [0, 1]",
  "defaultThreshold.max": "defaultThreshold must be in [0, 1]",
};

export const updateModelValidationRules = {
  defaultThreshold: "numeric|min:0|max:1",
};

export const updateModelValidationMessages = {
  "defaultThreshold.min": "defaultThreshold must be in [0, 1]",
  "defaultThreshold.max": "defaultThreshold must be in [0, 1]",
};

export const setModelStatusValidationRules = {
  status: "required|string|in:CANDIDATE,SHADOW,ACTIVE,RETIRED",
};

export const setModelStatusValidationMessages = {
  "status.required": "status is required",
  "status.in": "status must be one of: CANDIDATE, SHADOW, ACTIVE, RETIRED",
};

export const setSegmentThresholdValidationRules = {
  segment: "required|string|min:1|max:100",
  modelVersion: "required|string|min:1|max:100",
  threshold: "required|numeric|min:0|max:1",
};

export const setSegmentThresholdValidationMessages = {
  "segment.required": "segment is required",
  "modelVersion.required": "modelVersion is required",
  "threshold.required": "threshold is required",
  "threshold.min": "threshold must be in [0, 1]",
  "threshold.max": "threshold must be in [0, 1]",
};
