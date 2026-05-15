/**
 * E2E: composer plus menu — pick file via Filesystem plugin.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile composer plus — file", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("tapping file picks an item from the filesystem mock", async ({ page }) => {
    await page.evaluate(() => {
      const mock = (
        window as unknown as {
          __cogniaCapMock: { setFilesystemEntry: (p: string, d: string) => void }
        }
      ).__cogniaCapMock
      mock.setFilesystemEntry("/Documents/sample.pdf", "base64data")
    })
    await page.goto("/")
    await page
      .getByRole("button", { name: /\+|plus|attach/i })
      .first()
      .click()
    await page
      .getByRole("button", { name: /file|文件/i })
      .first()
      .click()
    await expect(page.getByTestId("composer-attachment").first()).toBeVisible({ timeout: 10_000 })
  })
})
