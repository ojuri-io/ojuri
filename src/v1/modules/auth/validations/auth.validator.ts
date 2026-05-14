export const loginValidationRules = {
  username: "required|string|min:1|max:64",
  password: "required|string|min:1",
  tenantId: "string|max:255",
};

export const loginValidationMessages = {
  "username.required": "username is required",
  "password.required": "password is required",
};
