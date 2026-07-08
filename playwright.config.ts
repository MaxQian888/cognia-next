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
 * Set PLAYWRIGHT_STATIC=1 to serve the prebuilt static export (`out/`) via
 * `scripts/e2e/serve-out.mjs` instead of `pnpm dev`. This removes Turbopack's
 * per-route on-demand compilation (~30s worst case on first hit) so the test
 * timeout drops back to 30s. The export must be built with
 * `NEXT_PUBLIC_E2E=1 pnpm build` first — `pnpm test:e2e:build` does exactly
 * that, and `pnpm test:e2e:static` runs the suite against it. The serve
 * script refuses to start when the export lacks the E2E bridge.
 *
 * Set PLAYWRIGHT_NO_GLOBAL_SETUP=1 to skip the V2 + per-service mock fleet
 * (only useful for the existing connector tests which spin up their own
 * mocks).
 */

import { defineConfig, devices } from "@playwright/test"

const tauriEnabled =
  process.env.PLAYWRIGHT_TAURI === "1" || process.env.PLAYWRIGHT_TAURI_DRIVER === "1"
const iosEnabled = process.env.PLAYWRIGHT_MOBILE_IOS === "1"
const staticMode = process.env.PLAYWRIGHT_STATIC === "1"

export default defineConfig({
  testDir: "./tests/e2e",
  // Files run in parallel across workers; tests WITHIN a file stay serial
  // (fullyParallel: false). Every chromium/mobile spec is parallel-safe: each
  // test gets a fresh browser context (fresh IndexedDB/Dexie), workflow specs
  // reset the DB per test, and the shared global-setup mock fleet is only
  // consumed read-only at its default scenario from these projects. The tauri
  // project is the exception — its fixture reuses the ONE WebView2 page/context
  // (tests/e2e/tauri/fixtures.ts) and its chat specs mutate the shared
  // anthropic mock scenario via /__control — so tauri runs stay single-worker.
  fullyParallel: false,
  // Each test's beforeEach reloads through AccountGate (the dev-unlock marker is
  // sessionStorage, reset per browser context) and waits for the test-globals
  // bridge to mount. Under Turbopack dev that mount races route compilation and
  // can approach 30s on the first hit of a route, so the default 30s test budget
  // is too tight. The static export (PLAYWRIGHT_STATIC=1) has no route
  // compilation, mounts fast, and keeps the default 30s budget.
  timeout: Number(process.env.PLAYWRIGHT_TEST_TIMEOUT ?? (staticMode ? 30_000 : 60_000)),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: tauriEnabled ? 1 : process.env.CI ? 4 : "50%",
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
    : staticMode
      ? {
          // Serves the prebuilt `out/` export — binds in well under a second,
          // so a short startup budget fails fast on a missing/stale build.
          command: "node scripts/e2e/serve-out.mjs --port 3000 --host 127.0.0.1",
          url: "http://localhost:3000",
          reuseExistingServer: !process.env.CI,
          timeout: Number(process.env.PLAYWRIGHT_WEBSERVER_TIMEOUT ?? 30_000),
          stdout: "ignore",
          stderr: "pipe",
        }
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
