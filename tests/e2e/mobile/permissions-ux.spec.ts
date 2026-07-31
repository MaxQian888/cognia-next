/**
 * E2E: permissions UX — denied permission surfaces the rationale screen.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — permissions UX", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android", cameraResult: null })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("requesting a permission that's denied surfaces the rationale CTA", async ({ page }) => {
    await page.goto("/")
    await page
      .getByRole("button", { name: /\+|plus|attach/i })
      .first()
      .click()
    await page
      .getByRole("button", { name: /camera|相机/i })
      .first()
      .click()
    await expect(page.getByText(/permission|授权|拒绝/i).first()).toBeVisible({ timeout: 15_000 })
  })
})
