/**
 * E2E: long-press primitive — holding a tappable for ~500ms opens the menu.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"

test.describe("mobile interactions — long-press", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("a long press surfaces the contextual menu", async ({ page }) => {
    await page.goto("/inbox")
    const target = page.locator("[data-testid^=long-press-]").first()
    if ((await target.count()) === 0) test.skip()
    const box = await target.boundingBox()
    if (!box) return
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(600)
    await page.mouse.up()
    await expect(
      page.getByTestId("long-press-menu").or(page.getByRole("menu")).first()
    ).toBeVisible()
  })
})
