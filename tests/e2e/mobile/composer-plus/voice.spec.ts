/**
 * E2E: composer plus menu — the chat composer mounts it with `showVoice=false`
 * (voice input there is the transcription bridge, speech → text, not an
 * attachment), so the sheet's record tile must be absent and the grid
 * three-across. The VoiceRecorder plugin path itself is exercised by the
 * component's jsdom suite.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile composer plus — voice", () => {
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

  test("the chat composer's sheet hides the record tile", async ({ page }) => {
    await page.goto("/")
    await page.getByTestId("composer-plus-toggle").click()
    const sheet = page.getByTestId("composer-plus-menu")
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId("composer-plus-voice")).toHaveCount(0)
    // Camera / album / file remain — the three real producers.
    await expect(sheet.getByTestId("composer-plus-camera")).toBeVisible()
    await expect(sheet.getByTestId("composer-plus-album")).toBeVisible()
    await expect(sheet.getByTestId("composer-plus-file")).toBeVisible()
  })
})
