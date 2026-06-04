// PAA Jest config — mirrors the root setup. The `test` script runs
// `jest --passWithNoTests` so this passes even with no specs in place;
// when tests get added under `paa-service/src/**/__tests__/` or
// `paa-service/test/` they'll be picked up automatically.

module.exports = {
  clearMocks: true,
  moduleDirectories: ["node_modules"],
  moduleFileExtensions: ["js", "json", "ts"],
  moduleNameMapper: {
    "^@config/(.*)$": "<rootDir>/src/config/$1",
    "^@services/(.*)$": "<rootDir>/src/services/$1",
    "^@utils/(.*)$": "<rootDir>/src/utils/$1",
  },
  rootDir: "./",
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  transform: {
    "^.+\\.(ts|tsx)$": "ts-jest",
  },
};
