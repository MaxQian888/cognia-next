/**
 * E2E: composer plus menu — capture photo via the Camera plugin.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile composer plus — camera", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      // pickPhoto runs with resultType "base64", which reads `base64String` —
      // the composer then fetches the `data:` URL, which always resolves.
      cameraResult: { format: "jpeg", saved: false, base64String: "/9j/" },
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

  test("tapping camera in the plus menu attaches a photo to the composer", async ({ page }) => {
    await page.goto("/")
    await page.getByTestId("composer-plus-toggle").click()
    await page.getByTestId("composer-plus-camera").click()
    await expect(page.getByTestId("composer-attachment-chip").first()).toBeVisible({
      timeout: 10_000,
    })
  })
})
