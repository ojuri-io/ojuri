module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
  // Source imports carry the `.js` suffix ESM output needs; strip it so the
  // CommonJS transform ts-jest applies can still resolve the .ts files.
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "CommonJS", moduleResolution: "Node10" } }],
  },
};
