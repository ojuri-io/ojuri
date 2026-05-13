export const createSampleRules = {
  name: "required|string|min:5|max:100",
  email: "email",
  phoneNumber: "min:11|max:13|phone",
  address: "string|min:5|max:100",
};

export const createSampleRulesMessages = {
  "max.phoneNumber": `The phoneNumber field should not be greater than 13 characters. Example of allowed format is 2348888888888.`,
};

export const updateSampleRules = createSampleRules;
