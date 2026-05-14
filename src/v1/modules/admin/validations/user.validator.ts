export const createUserValidationRules = {
  username: "required|string|min:1|max:64",
  password: "required|string|min:8|max:255",
  fullName: "string|max:255",
  email: "string|email|max:255",
  tenantId: "string|max:255",
  "roleIds.*": "string",
};

export const createUserValidationMessages = {
  "username.required": "username is required",
  "password.required": "password is required",
  "password.min": "password must be at least 8 characters",
  "email.email": "email must be a valid email address",
};

export const updateUserValidationRules = {
  password: "string|min:8|max:255",
  fullName: "string|max:255",
  email: "string|email|max:255",
  isActive: "boolean",
  disabledReason: "string|max:255",
};

export const updateUserValidationMessages = {
  "password.min": "password must be at least 8 characters",
  "email.email": "email must be a valid email address",
};

export const assignRoleValidationRules = {
  roleId: "required|string",
};

export const assignRoleValidationMessages = {
  "roleId.required": "roleId is required",
};
