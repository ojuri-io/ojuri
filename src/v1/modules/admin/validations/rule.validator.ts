export const createRuleValidationRules = {
  name: "required|string|min:1|max:255",
  description: "string|max:2000",
  stage: "string|in:PRE,POST",
  priority: "numeric|min:0|max:100000",
  action: "required|string|in:ALLOW,DENY,REVIEW,NONE",
  expression: "required",
  tenantId: "string|max:255",
  isActive: "boolean",
};

export const createRuleValidationMessages = {
  "name.required": "Rule name is required",
  "action.required": "action is required",
  "action.in": "action must be one of: ALLOW, DENY, REVIEW, NONE",
  "expression.required": "expression is required",
  "stage.in": "stage must be PRE or POST",
};

export const updateRuleValidationRules = {
  name: "string|min:1|max:255",
  description: "string|max:2000",
  stage: "string|in:PRE,POST",
  priority: "numeric|min:0|max:100000",
  action: "string|in:ALLOW,DENY,REVIEW,NONE",
  isActive: "boolean",
};

export const updateRuleValidationMessages = {
  "action.in": "action must be one of: ALLOW, DENY, REVIEW, NONE",
  "stage.in": "stage must be PRE or POST",
};
