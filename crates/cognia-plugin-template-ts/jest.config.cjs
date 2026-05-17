/**
 * Jest config for the cognia TypeScript plugin template.
 *
 * Uses ts-jest in jsdom mode so plugin code that touches browser APIs
 * (clipboard, navigator, fetch) tests cleanly without a real browser.
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  moduleNameMapper: {
    // Host types are injected at runtime by cognia — keep them as `any`
    // shims at test time so we don't pull the whole monorepo in.
    "^@/(.*)$": "<rootDir>/src/__shims__/$1",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts", "!src/__shims__/**"],
}
