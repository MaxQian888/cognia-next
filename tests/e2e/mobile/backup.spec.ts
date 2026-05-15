/**
 * E2E: mobile backup section under /me — export + import affordances.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — backup", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("backup card renders + export button is enabled", async ({ page }) => {
    await page.goto("/me")
    const exportBtn = page.getByRole("button", { name: /export|导出/i }).first()
    await expect(exportBtn).toBeVisible({ timeout: 15_000 })
    await expect(exportBtn).toBeEnabled()
  })
})
