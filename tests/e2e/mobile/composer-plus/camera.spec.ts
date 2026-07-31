/**
 * E2E: composer plus menu — capture photo via the Camera plugin.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile composer plus — camera", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      cameraResult: { format: "jpeg", saved: false, dataUrl: "data:image/jpeg;base64,/9j/" },
    })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("tapping camera in the plus menu attaches a photo to the composer", async ({ page }) => {
    await page.goto("/")
    await page
      .getByRole("button", { name: /\+|plus|attach/i })
      .first()
      .click()
    await page
      .getByRole("button", { name: /camera|相机/i })
      .first()
      .click()
    await expect(page.getByTestId("composer-attachment").first()).toBeVisible({ timeout: 10_000 })
  })
})
