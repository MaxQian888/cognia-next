/**
 * Jest config for the cognia TypeScript plugin template.
 *
 * Uses ts-jest in jsdom mode so plugin code that touches browser APIs
 * (clipboard, navigator, fetch) tests cleanly without a real browser.
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  // `.tsx` too — the template ships a React panel and its test alongside the
  // plain-TS entry point, and a `.ts`-only pattern silently skips them.
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/src/**/*.test.tsx"],
  // Supplies `toBeInTheDocument` and friends to the panel test.
  setupFilesAfterEnv: ["@testing-library/jest-dom"],
  // The `@cognia/*` packages are not installed — the host supplies them at
  // runtime and `tsconfig.json` `paths` covers type-checking. Jest resolves for
  // real, so it needs somewhere to land. See `src/__stubs__/`.
  moduleNameMapper: {
    "^@cognia/plugin-sdk$": "<rootDir>/src/__stubs__/plugin-sdk.ts",
    "^@cognia/plugin-ui$": "<rootDir>/src/__stubs__/plugin-ui.tsx",
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "src/**/*.tsx",
    "!src/**/*.test.ts",
    "!src/**/*.test.tsx",
    "!src/__stubs__/**",
  ],
}
