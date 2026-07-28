/**
 * E2E: mobile Discover page — 4 sub-tabs (characters / teams / skills / twin).
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { injectCapacitor } from "../helpers/inject-capacitor"

test.describe("mobile — discover page", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("all 4 sub-tabs are visible + switchable", async ({ page }) => {
    await page.goto("/discover")
    const characters = page.getByRole("tab", { name: /character/i })
    const teams = page.getByRole("tab", { name: /team/i })
    const skills = page.getByRole("tab", { name: /skill/i })
    const twin = page.getByRole("tab", { name: /twin/i })
    await expect(characters).toBeVisible()
    await expect(teams).toBeVisible()
    await expect(skills).toBeVisible()
    await expect(twin).toBeVisible()
    await teams.click()
    await skills.click()
    await twin.click()
  })
})
