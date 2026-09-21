/**
 * E2E: composer plus menu — pick photo from album.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile composer plus — album", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      // Album picks only carry `webPath`, which the composer fetches — so it
      // must be a same-origin URL, not a `file://` Chromium can't load.
      cameraResult: { format: "png", saved: true, webPath: "/apple-icon.png" },
    })
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

  test("tapping album surfaces a chosen photo into the composer", async ({ page }) => {
    await page.goto("/")
    await page.getByTestId("composer-plus-toggle").click()
    await page.getByTestId("composer-plus-album").click()
    await expect(page.getByTestId("composer-attachment-chip").first()).toBeVisible({
      timeout: 10_000,
    })
  })
})
