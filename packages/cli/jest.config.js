// CLI Jest config. Mirrors paa-service/jest.config.js. Specs live under
// packages/cli/test/, which the build tsconfig excludes so dist/ holds
// no test code; tsconfig.test.json adds them back for ts-jest.
module.exports = {
  clearMocks: true,
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "./",
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
};
