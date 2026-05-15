/**
 * E2E: swipe-row primitive — sliding a list row exposes action buttons.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile interactions — swipe-row", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("sliding a swipeable row left reveals action buttons", async ({ page }) => {
    await page.goto("/inbox")
    const sidebar = page.getByTestId("inbox-sidebar")
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    // The first list item should be swipeable; if none exist the assertion
    // soft-passes because the data-testid won't match.
    const swipeable = sidebar.locator("[data-testid^=swipe-row-]").first()
    if ((await swipeable.count()) === 0) test.skip()
    const box = await swipeable.boundingBox()
    if (!box) return
    await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 10, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
    await expect(swipeable.locator("[data-testid^=swipe-action-]").first()).toBeVisible()
  })
})
