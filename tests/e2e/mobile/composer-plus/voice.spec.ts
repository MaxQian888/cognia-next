/**
 * E2E: composer plus menu — record voice via VoiceRecorder plugin.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile composer plus — voice", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      voiceRecording: { recordDataBase64: "AAAA", msDuration: 1200, mimeType: "audio/aac" },
    })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("tapping voice records a clip and attaches it to the composer", async ({ page }) => {
    await page.goto("/")
    await page
      .getByRole("button", { name: /\+|plus|attach/i })
      .first()
      .click()
    await page
      .getByRole("button", { name: /voice|语音/i })
      .first()
      .click()
    await page.waitForTimeout(200)
    await page
      .getByRole("button", { name: /stop|结束|完成/i })
      .first()
      .click()
    await expect(page.getByTestId("composer-attachment").first()).toBeVisible({ timeout: 10_000 })
  })
})
