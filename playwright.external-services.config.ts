import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e/external-services",
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
