/**
 * Jest config for the cognia glance module plugin template.
 *
 * Node environment: the plugin renders nothing (the host draws the module
 * from the data it publishes), so there is no DOM to test against.
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  // The `@cognia/*` packages are not installed — the host supplies them at
  // runtime and `tsconfig.json` `paths` covers type-checking. Jest resolves for
  // real, so it needs somewhere to land. See `src/__stubs__/`.
  moduleNameMapper: {
    "^@cognia/plugin-sdk$": "<rootDir>/src/__stubs__/plugin-sdk.ts",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts", "!src/__stubs__/**"],
}
