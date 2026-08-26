/**
 * Jest runs from `apps/mobile` only.
 *
 * The repository root uses vitest, and its `unit` project excludes `apps/**` so these files are
 * never picked up by the server test run — a React Native suite executed under vitest fails in
 * ways that look like product bugs.
 */
module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  // `@pawsh/domain` is a `file:` dependency whose real path is outside this project, so Babel's
  // helpers — injected when its compiled ESM is transformed for Jest — resolve from
  // `packages/domain` upward and miss this app's tree. Only the helpers are redirected; adding
  // the whole directory to `modulePaths` loads some packages twice under Windows path casing,
  // which quietly gives a suite two copies of the testing library.
  moduleNameMapper: {
    "^@babel/runtime/(.*)$": "<rootDir>/node_modules/@babel/runtime/$1"
  },
  testMatch: ["<rootDir>/__tests__/**/*.test.ts", "<rootDir>/__tests__/**/*.test.tsx"],
  collectCoverageFrom: ["src/**/*.{ts,tsx}", "app/**/*.tsx"],
  transformIgnorePatterns: [
    "node_modules/(?!(?:jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|react-native-svg|@tanstack/.*)"
  ]
};
