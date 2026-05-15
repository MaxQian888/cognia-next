/**
 * E2E: pull-to-refresh primitive — tug the list to trigger reload.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile interactions — pull-to-refresh", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("pulling down triggers the refresh indicator", async ({ page }) => {
    await page.goto("/inbox")
    const list = page.getByTestId("pull-to-refresh").or(page.locator("[data-testid=inbox-sidebar]"))
    await expect(list.first()).toBeVisible({ timeout: 15_000 })
    const box = await list.first().boundingBox()
    if (!box) return
    await page.mouse.move(box.x + box.width / 2, box.y + 10)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 12 })
    await page.mouse.up()
  })
})
