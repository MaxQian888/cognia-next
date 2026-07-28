/**
 * E2E: mobile 4-tab shell — chat / workflows / discover / me.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { bootstrapCogniaMobile } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile shell — 4-tab navigation", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await bootstrapCogniaMobile(page, "standalone")
  })

  test("@smoke tab bar renders and each tab routes correctly", async ({ page }) => {
    await page.goto("/")
    const bar = page.getByTestId("mobile-tab-bar")
    await expect(bar).toBeVisible({ timeout: 15_000 })
    await bar.getByRole("tab", { name: /workflow|工作流/i }).click()
    await page.waitForURL(/\/workflows/)
    await bar.getByRole("tab", { name: /discover|发现/i }).click()
    await page.waitForURL(/\/discover/)
    await bar.getByRole("tab", { name: /me|我/i }).click()
    await page.waitForURL(/\/me/)
    await bar.getByRole("tab", { name: /chat|聊天/i }).click()
    await page.waitForURL(/\/$|\/inbox/)
  })
})
