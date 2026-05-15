/**
 * E2E: composer plus menu — pick photo from album.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile composer plus — album", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      cameraResult: { format: "png", saved: true, webPath: "file://mock/photo.png" },
    })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("tapping album surfaces a chosen photo into the composer", async ({ page }) => {
    await page.goto("/")
    await page
      .getByRole("button", { name: /\+|plus|attach/i })
      .first()
      .click()
    await page
      .getByRole("button", { name: /album|相册/i })
      .first()
      .click()
    await expect(page.getByTestId("composer-attachment").first()).toBeVisible({ timeout: 10_000 })
  })
})
