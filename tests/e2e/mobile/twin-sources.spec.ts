/**
 * E2E: mobile twin sources panel — listing + add-source affordance.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — twin sources", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("twin sources tab renders empty state + add-source button", async ({ page }) => {
    await page.goto("/discover?tab=twin")
    await expect(page.getByRole("button", { name: /add source|添加来源/i }).first()).toBeVisible({
      timeout: 15_000,
    })
  })
})
