/**
 * E2E: long-press primitive — holding a row for ~500ms opens its action
 * sheet, and a sheet action actually runs.
 *
 * Target surface: the mobile workflow library (/workflows), whose rows wrap
 * <LongPress onLongPress={openActionsSheet}>. Two earlier incarnations of
 * this spec could never fail: the first probed `[data-testid^=long-press-]`
 * (a testid no product code renders) and skipped when it matched nothing;
 * a rewrite targeted /me rows, where the connection badge/transport
 * indicator polling keeps shifting layout mid-hold — the row slides out
 * from under the stationary pointer, pointerleave cancels the gesture, and
 * the outcome was a coin flip. The workflow list is static once mounted.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb, setCogniaSettings } from "../../helpers/db-reset"
import { injectCapacitor } from "../../helpers/inject-capacitor"
import { seedWorkflow } from "../../helpers/seed-workflow"

test.describe("mobile interactions — long-press", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    await setCogniaSettings(page, { mobileRuntimeMode: "standalone" })
  })

  test("long-pressing a workflow row opens the actions sheet; pin persists", async ({ page }) => {
    const wfId = await seedWorkflow(page, "manual-ai")
    await page.goto("/workflows")

    const row = page.getByTestId(`workflow-row-${wfId}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    // Raw mouse.* does NOT auto-scroll like locator.click(); also let the
    // entrance stagger + the post-seed liveQuery refresh settle — a row
    // remount mid-hold unmounts the LongPress span and clears its timer.
    await row.scrollIntoViewIfNeeded()
    await page.waitForTimeout(2_000)

    const sheet = page.getByTestId("workflow-row-actions-sheet")
    // Real outcome 1: the actions sheet opened. One retry: workflow-list
    // rows can still remount once shortly after seeding (trigger-registration
    // sync), which cancels an in-flight hold — a second hold on the settled
    // row is deterministic.
    for (let attempt = 0; attempt < 2; attempt++) {
      const box = await row.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(900)
      await page.mouse.up()
      if (await sheet.isVisible().catch(() => false)) break
      await page.waitForTimeout(1_000)
    }
    await expect(sheet).toBeVisible({ timeout: 10_000 })

    // Real outcome 2: an action from the sheet takes effect — pin renders
    // the row's "pinned" badge after the sheet closes.
    await sheet.getByTestId("workflow-action-pin").click()
    await expect(page.getByTestId(`workflow-pinned-${wfId}`)).toBeVisible({ timeout: 10_000 })
  })
})
