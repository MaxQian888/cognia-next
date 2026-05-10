/**
 * Playwright E2E configuration — Task 113.
 *
 * Prerequisites:
 *   pnpm add -D express @types/express @playwright/test
 *   pnpx playwright install chromium
 *   pnpm dev   # :3000 must be running
 *
 * Run:
 *   pnpx playwright test
 *   pnpx playwright test tests/e2e/connectors/  # connector tests only
 */

import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // connector tests share the mock server
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Wave 3.7 — mobile-viewport e2e suite. Specs live under
    // tests/e2e/mobile/. Pixel 7 covers the Android Chromium path; the
    // iPhone 13 project is opt-in because webkit must be installed
    // separately (`pnpx playwright install webkit`).
    {
      name: "mobile-pixel-7",
      testDir: "./tests/e2e/mobile",
      use: { ...devices["Pixel 7"] },
    },
    {
      name: "mobile-iphone-13",
      testDir: "./tests/e2e/mobile",
      use: { ...devices["iPhone 13"] },
    },
  ],

  // No `webServer` block because `pnpm dev` is expected to already be running.
  // Add it if you want Playwright to manage the server lifecycle:
  //
  // webServer: {
  //   command: "pnpm dev",
  //   url: "http://localhost:3000",
  //   reuseExistingServer: !process.env.CI,
  // },
})
