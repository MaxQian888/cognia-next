import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.COGNIA_REAL_WEB_URL ?? "https://cognia.localhost"
const hostname = new URL(baseURL).hostname

export default defineConfig({
  testDir: "./tests/real-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-web-headless" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    ignoreHTTPSErrors: true,
    // A real installed PWA may keep the previous static bundle's IndexedDB
    // connection alive while the freshly built page registers plugin tables.
    // This lane validates the current Web ↔ Headless protocol, so keep one
    // renderer realm and prevent a stale service worker from blocking Dexie
    // schema upgrades before pairing can begin.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      // The OIDC fixture is intentionally plain HTTP inside the CI-only
      // Compose network. Chromium maps that service name to its published
      // loopback port and permits mixed content only for this deterministic
      // test lane; production OIDC remains HTTPS-only.
      args: [
        `--host-resolver-rules=MAP ${hostname} 127.0.0.1,MAP oidc-fixture 127.0.0.1`,
        "--allow-running-insecure-content",
      ],
    },
  },
})
