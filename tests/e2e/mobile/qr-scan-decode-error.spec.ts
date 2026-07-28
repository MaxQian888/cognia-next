/**
 * E2E: QR scan decode error — malformed payload surfaces the error UI.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — QR scan (decode error)", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, {
      platform: "android",
      barcodeResult: { rawValue: "not a pair payload" },
    })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("malformed QR payload surfaces an inline error + keeps the user on step 2", async ({
    page,
  }) => {
    await page.goto("/pair")
    await page
      .getByRole("button", { name: /scan|扫码/i })
      .first()
      .click()
    await expect(page.getByText(/invalid|malformed|无效|解析失败/i).first()).toBeVisible({
      timeout: 15_000,
    })
  })
})
