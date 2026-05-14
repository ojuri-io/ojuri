export const createRoleValidationRules = {
  name: "required|string|min:1|max:64",
  description: "string|max:512",
  permissions: "required|array|min:1",
  "permissions.*": "string",
  tenantId: "string|max:255",
};

export const createRoleValidationMessages = {
  "name.required": "name is required",
  "permissions.required": "permissions is required",
  "permissions.min": "A role must grant at least one permission",
};

export const updateRoleValidationRules = {
  name: "string|min:1|max:64",
  description: "string|max:512",
  permissions: "array",
  "permissions.*": "string",
};

export const updateRoleValidationMessages = {
  "permissions.array": "permissions must be an array of permission codes",
};
