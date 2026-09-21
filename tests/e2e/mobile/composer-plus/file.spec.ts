/**
 * E2E: composer plus menu — pick file via Filesystem plugin.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile composer plus — file", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    // The reset also clears `mobileRuntimeMode` and `onboardingProgress`, and
    // the ADR-0122 gate routes a session-less account into the first-run flow —
    // the `+` sheet only exists once both say "already set up".
    await setCogniaSettings(page, {
      mobileRuntimeMode: "standalone",
      onboardingProgress: {
        version: 2,
        path: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    })
  })

  test("picking a file attaches it to the composer", async ({ page }) => {
    await page.goto("/")
    await page.getByTestId("composer-plus-toggle").click()
    // The file tile is a <label> over a real <input type=file> (Capacitor v7
    // has no unified picker), so the honest drive is setInputFiles, not a tap.
    await page.getByTestId("composer-plus-file-input").setInputFiles({
      name: "sample.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("base64data"),
    })
    await expect(page.getByTestId("composer-attachment-chip").first()).toBeVisible({
      timeout: 10_000,
    })
  })
})
