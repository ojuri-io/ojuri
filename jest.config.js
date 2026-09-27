module.exports = {
  clearMocks: true,
  setupFiles: ['<rootDir>/jest.setup.ts'],
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/__fixtures__/',
    '/__tests__/',
    '/(__)?mock(s__)?/',
    '/__jest__/',
    '.?.min.js',
  ],
  moduleDirectories: ['node_modules', 'packages'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@utils/(.*)$': '<rootDir>/src/shared/utils/$1',
  },
  resetModules: true,
  rootDir: './',
  // Frontend has its own Vitest runner under `frontend/`. Skip those
  // specs so Jest doesn't try to parse JSX/ESM modules it can't load.
  // `packages/` holds the CLI and the client SDKs, each with its own
  // Jest config and tsconfig. Without this the root runner would try to
  // compile their specs against the root tsconfig and fail.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/frontend/',
    '/paa-service/',
    '/mla-service/',
    '/fia-service/',
    '/packages/',
  ],
  testEnvironment: 'node',
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  verbose: true,
};
