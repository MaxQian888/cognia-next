/**
 * Playwright E2E configuration.
 *
 * Prerequisites:
 *   pnpm add -D express @types/express @playwright/test
 *   pnpx playwright install chromium
 *
 * Run:
 *   pnpm test:e2e                       # whole suite (web projects only)
 *   pnpm test:e2e:workflows             # workflow editor specs only
 *   pnpm test:e2e:mobile                # mobile (Pixel 7) specs only
 *   pnpm test:e2e:mobile:ios            # mobile (iPhone 13 / WebKit) specs
 *   pnpm test:e2e:tauri                 # tauri-driver project (opt-in)
 *
 * The `tauri-driver` project is gated by `PLAYWRIGHT_TAURI_DRIVER=1` because
 * it requires a built Tauri debug binary plus the `tauri-driver` binary on
 * PATH (see `tests/e2e/helpers/tauri-driver-launch.ts`). Set the env var to
 * include it in the matrix; otherwise the project's specs are skipped at
 * project-resolution time.
 *
 * By default Playwright manages the Next.js dev server lifecycle via the
 * `webServer` block. Set PLAYWRIGHT_NO_SERVER=1 to opt out (when you already
 * have `pnpm dev` running in another shell).
 *
 * Set PLAYWRIGHT_NO_GLOBAL_SETUP=1 to skip the V2 + per-service mock fleet
 * (only useful for the existing connector tests which spin up their own
 * mocks).
 */

import { defineConfig, devices } from "@playwright/test"

const tauriDriverEnabled = process.env.PLAYWRIGHT_TAURI_DRIVER === "1"
const iosEnabled = process.env.PLAYWRIGHT_MOBILE_IOS === "1"

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // connector + workflow tests share Dexie singleton in dev
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],

  globalSetup: process.env.PLAYWRIGHT_NO_GLOBAL_SETUP ? undefined : "./tests/e2e/global-setup.ts",

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  webServer: process.env.PLAYWRIGHT_NO_SERVER
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: Number(process.env.PLAYWRIGHT_WEBSERVER_TIMEOUT ?? 300_000),
        stdout: "ignore",
        stderr: "pipe",
        env: {
          NEXT_PUBLIC_E2E: "1",
        },
      },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: ["**/tests/e2e/tauri/**", "**/tests/e2e/mobile/**"],
    },
    // Mobile-viewport e2e suite. Pixel 7 covers the Android Chromium path; the
    // iPhone 13 project is opt-in (webkit must be installed separately).
    {
      name: "mobile-pixel-7",
      testDir: "./tests/e2e/mobile",
      use: { ...devices["Pixel 7"] },
    },
    ...(iosEnabled
      ? [
          {
            name: "mobile-iphone-13",
            testDir: "./tests/e2e/mobile",
            use: { ...devices["iPhone 13"] },
          },
        ]
      : []),
    // Tauri-driver project — runs the four originally-skipped flows against
    // a real Tauri shell over CDP (see `tests/e2e/tauri/global-setup.ts`).
    // Opt in with PLAYWRIGHT_TAURI_DRIVER=1.
    ...(tauriDriverEnabled
      ? [
          {
            name: "tauri-driver",
            testDir: "./tests/e2e/tauri",
            use: {
              // Tauri attaches Playwright over Chromium DevTools Protocol;
              // the per-test fixture in tests/e2e/tauri/fixtures.ts swaps the
              // browser instance for the connected one.
              browserName: "chromium",
              connectOptions: {
                wsEndpoint: process.env.PLAYWRIGHT_TAURI_CDP_WS ?? "",
              },
            },
          },
        ]
      : []),
  ],
})
