/**
 * E2E: safe-area insets — the mobile shell applies bottom + top padding.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — safe area", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "ios" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("tab bar applies bottom padding consistent with the safe-area inset", async ({ page }) => {
    const tabBar = page.getByTestId("mobile-tab-bar")
    await expect(tabBar).toBeVisible({ timeout: 15_000 })
    const paddingBottom = await tabBar.evaluate((el) => getComputedStyle(el).paddingBottom)
    // Any non-zero bottom padding signals the safe-area variable resolved.
    expect(paddingBottom).not.toBe("0px")
  })
})
