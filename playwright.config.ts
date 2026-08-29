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
const crossBrowserEnabled = process.env.PLAYWRIGHT_CROSS_BROWSER === "1"
const staticMode = process.env.PLAYWRIGHT_STATIC === "1"
const isCI = Boolean(process.env.CI)

// The three directories no ordinary web project may pick up. `browser-extension`
// joins tauri and mobile because its specs launch their OWN browser — a
// persistent context with `--load-extension`, which only Chromium supports —
// so running them under the firefox/webkit projects would start a browser that
// is then ignored and assert against one that was never configured.
const WEB_PROJECT_IGNORE = [
  "**/tests/e2e/tauri/**",
  "**/tests/e2e/mobile/**",
  "**/tests/e2e/browser-extension/**",
]

export default defineConfig({
  testDir: "./tests/e2e",
  // Visual baselines are generated from the same checked-in web fonts and
  // fixed Chromium project in CI. Keeping the path OS-neutral makes the
  // baseline reviewable once instead of silently creating per-runner copies.
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  // Individual tests — not just files — spread across workers. Every
  // chromium/mobile spec is parallel-safe: each test gets a fresh browser
  // context (fresh IndexedDB/Dexie), workflow specs reset the DB per test, and
  // the shared global-setup mock fleet is only consumed read-only at its
  // default scenario from these projects. File-level parallelism alone pins a
  // big file to one worker: tests/e2e/plugins/responsive.spec.ts holds 60 tests
  // in a single file and dominated the suite's wall-clock as a result. The
  // tauri project opts out (see below) — its fixture reuses the ONE WebView2
  // page/context (tests/e2e/tauri/fixtures.ts) and its chat specs mutate the
  // shared anthropic mock scenario via /__control, so its tests must stay
  // serial.
  fullyParallel: true,
  // Each test's beforeEach re-boots the full app through AccountGate (fresh
  // browser context per test), and boot includes the plugin manager's dynamic
  // Dexie table registration — measured at 10-25s under parallel-worker
  // contention even on the static export. The historical 30s static budget
  // assumed "mounts fast" and made every heavyweight spec fail in its
  // beforeEach the moment workers competed; 60s reflects the measured cost.
  timeout: Number(process.env.PLAYWRIGHT_TEST_TIMEOUT ?? 60_000),
  // The same measurement applies to the FIRST assertion of a `beforeEach`,
  // which is what actually waits for that boot — typically
  // `expect(...).toBeVisible()` on a landmark of the route under test. Raising
  // only the test budget above left that assertion on Playwright's 5s default,
  // so a spec would fail its beforeEach at 5s while 55s of its own budget went
  // unused, and the failure looked like a broken page (the app was still on
  // AccountGate's loading shell) rather than a clock that was set too tight.
  // Measured here: gate-open is ~1.9s with one worker and ~9-10s at seven,
  // against the config's documented 10-25s band under heavier contention.
  expect: { timeout: Number(process.env.PLAYWRIGHT_EXPECT_TIMEOUT ?? 20_000) },
  forbidOnly: isCI,
  // A retry is diagnostic evidence, not permission to merge an unstable test.
  retries: isCI ? 1 : 0,
  failOnFlakyTests: isCI,
  workers: tauriEnabled ? 1 : isCI ? 4 : "50%",
  maxFailures: isCI ? 10 : 0,
  globalTimeout: isCI ? 30 * 60_000 : 0,
  reporter: isCI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],

  globalSetup: process.env.PLAYWRIGHT_NO_GLOBAL_SETUP ? undefined : "./tests/e2e/global-setup.ts",

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: process.env.E2E_LOCALE ?? "en-US",
    timezoneId: process.env.E2E_TIMEZONE ?? "UTC",
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
            NEXT_PUBLIC_SHARED_CHAT_ENABLED: "true",
          },
        },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: WEB_PROJECT_IGNORE,
    },
    ...(crossBrowserEnabled
      ? [
          {
            name: "firefox",
            use: { ...devices["Desktop Firefox"] },
            testIgnore: WEB_PROJECT_IGNORE,
          },
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
            testIgnore: WEB_PROJECT_IGNORE,
          },
        ]
      : []),
    // Mobile-viewport e2e suite. Pixel 7 covers the Android Chromium path; the
    // iPhone 13 project is opt-in (webkit must be installed separately).
    // 60s budget even in static mode: with the Capacitor mock injected the
    // full app boots (plugin manager included, whose dynamic Dexie table
    // registration briefly self-blocks the 'cognia-claude' upgrade), and
    // resetCogniaDb pays that boot twice per test (initial goto + the
    // post-account-seed reload) — ~15-25s under worker contention.
    {
      name: "mobile-pixel-7",
      testDir: "./tests/e2e/mobile",
      timeout: 90_000,
      use: { ...devices["Pixel 7"] },
    },
    ...(iosEnabled
      ? [
          {
            name: "mobile-iphone-13",
            testDir: "./tests/e2e/mobile",
            timeout: 90_000,
            use: { ...devices["iPhone 13"] },
          },
        ]
      : []),
    // Browser Companion extension — a real Chrome MV3 extension in a real
    // Chromium. Its fixture overrides `context` with
    // `chromium.launchPersistentContext(--load-extension)`, so this project
    // contributes the test directory and the budget and nothing else: the
    // `use` block below would be ignored. It needs `browser-extension/build/`
    // to exist; `pnpm browser-ext:e2e` builds first, and the fixture fails
    // with that instruction rather than with a missing-file stack.
    {
      name: "browser-extension",
      testDir: "./tests/e2e/browser-extension",
      // Each test launches its own Chromium and copies a ~400 KB profile, on
      // top of the app boot every other project pays. Measured at 3-6s per
      // test; the budget is the shared 60s.
      timeout: Number(process.env.PLAYWRIGHT_TEST_TIMEOUT ?? 60_000),
    },
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
            // Opts out of the global fullyParallel: the CDP fixture reuses one
            // WebView2 page/context and chat specs mutate the shared mock
            // scenario, so tests must not interleave. (The tauriEnabled branch
            // of `workers` above already forces a single worker; this keeps the
            // constraint explicit at the project level.)
            fullyParallel: false,
          },
        ]
      : []),
  ],
})
