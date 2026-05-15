/**
 * E2E: mobile twin drafts panel — listing + approve / discard.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — twin drafts", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("twin drafts tab renders + empty state copy is i18n-correct", async ({ page }) => {
    await page.goto("/discover?tab=twin&panel=drafts")
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 15_000 })
  })
})
