/**
 * E2E: i18n locale switching surfaces translated strings.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — i18n switching", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("switching locale to zh-CN renders Chinese tab labels", async ({ page }) => {
    await page.goto("/me")
    const language = page.getByRole("button", { name: /language|语言/i }).first()
    if (!(await language.count())) test.skip()
    await language.click()
    await page
      .getByRole("menuitem", { name: /中文|chinese/i })
      .first()
      .click()
    await page.goto("/")
    const tabBar = page.getByTestId("mobile-tab-bar")
    await expect(tabBar.getByRole("tab", { name: /发现/ })).toBeVisible({ timeout: 15_000 })
  })
})
