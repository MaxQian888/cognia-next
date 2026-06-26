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
 *   pnpm test:e2e:tauri                 # tauri project (opt-in, Windows-only)
 *
 * The `tauri` project is gated by `PLAYWRIGHT_TAURI=1`. It boots the Tauri
 * debug binary with WebView2 CDP enabled and connects via
 * `chromium.connectOverCDP` from a per-test fixture
 * (see `tests/e2e/helpers/tauri-cdp-launch.ts` and `tests/e2e/tauri/fixtures.ts`).
 * `PLAYWRIGHT_TAURI_DRIVER=1` is honored as a legacy alias for one release cycle.
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

const tauriEnabled =
  process.env.PLAYWRIGHT_TAURI === "1" || process.env.PLAYWRIGHT_TAURI_DRIVER === "1"
const iosEnabled = process.env.PLAYWRIGHT_MOBILE_IOS === "1"

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // connector + workflow tests share Dexie singleton in dev
  // Each test's beforeEach reloads through AccountGate (the dev-unlock marker is
  // sessionStorage, reset per browser context) and waits for the test-globals
  // bridge to mount. Under Turbopack dev that mount races route compilation and
  // can approach 30s on the first hit of a route, so the default 30s test budget
  // is too tight. A static-export CI build mounts fast and never approaches this.
  timeout: Number(process.env.PLAYWRIGHT_TEST_TIMEOUT ?? 60_000),
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
    // Tauri project — runs IPC-bound flows against a real Tauri shell
    // over WebView2 CDP. The per-test fixture in `tests/e2e/tauri/fixtures.ts`
    // calls `chromium.connectOverCDP(process.env.PLAYWRIGHT_TAURI_CDP_WS)`
    // (the env is published by `tests/e2e/global-setup.ts` after spawning the
    // Tauri debug binary via `tests/e2e/helpers/tauri-cdp-launch.ts`). Opt in
    // with PLAYWRIGHT_TAURI=1.
    ...(tauriEnabled
      ? [
          {
            name: "tauri",
            testDir: "./tests/e2e/tauri",
          },
        ]
      : []),
  ],
})
