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
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts"],
}
