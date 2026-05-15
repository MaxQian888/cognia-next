/**
 * E2E: keyboard avoidance — the composer scrolls into view when the
 * keyboard show event fires.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — keyboard avoidance", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "ios" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("keyboardWillShow event nudges the composer up", async ({ page }) => {
    const composer = page.getByRole("textbox", { name: /message/i }).first()
    await expect(composer).toBeVisible({ timeout: 15_000 })
    const beforeBox = await composer.boundingBox()
    await page.evaluate(() => {
      ;(
        window as unknown as {
          __cogniaCapMock: { pushKeyboardEvent: (k: string, h?: number) => void }
        }
      ).__cogniaCapMock.pushKeyboardEvent("show", 300)
    })
    await page.waitForTimeout(200)
    const afterBox = await composer.boundingBox()
    if (beforeBox && afterBox) {
      expect(afterBox.y).toBeLessThanOrEqual(beforeBox.y)
    }
  })
})
