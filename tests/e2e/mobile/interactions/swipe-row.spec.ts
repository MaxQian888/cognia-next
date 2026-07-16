/**
 * E2E: swipe-row primitive — sliding a list row exposes action buttons, and
 * the action actually runs.
 *
 * Target surface: the mobile workflow library (/workflows), whose rows are
 * wrapped in <SwipeRow rightActions={[run, pin]}>. An earlier version of
 * this spec looked for swipeable rows inside the inbox sidebar — which never
 * wraps rows in SwipeRow — and skipped every run when the locator (naturally)
 * matched nothing.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb, setCogniaSettings } from "../../helpers/db-reset"
import { touchDrag } from "../../helpers/gestures"
import { injectCapacitor } from "../../helpers/inject-capacitor"
import { seedWorkflow } from "../../helpers/seed-workflow"

test.describe("mobile interactions — swipe-row", () => {
  test.beforeEach(async ({ page }) => {
    await injectCapacitor(page, { platform: "android" })
    await page.goto("/")
    await resetCogniaDb(page)
    await setCogniaSettings(page, { mobileRuntimeMode: "standalone" })
  })

  test("sliding a workflow row left reveals actions and pin actually pins", async ({ page }) => {
    const wfId = await seedWorkflow(page, "manual-ai")
    await page.goto("/workflows")

    // The seeded row must exist — no row, no test.
    const row = page.getByTestId(`workflow-row-${wfId}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    // Raw mouse.* does NOT auto-scroll like locator.click(); also let the
    // entrance stagger + the post-seed liveQuery refresh settle — a row
    // remount mid-gesture resets the SwipeRow's reveal state.
    await row.scrollIntoViewIfNeeded()
    await page.waitForTimeout(2_000)

    // Touch-drag the SwipeRow foreground leftwards past the reveal
    // threshold (mouse drags across the row's <Link> start a native HTML5
    // drag that cancels the pointer stream — see helpers/gestures.ts).
    // Start at 60% width — the row's right edge holds the TriggerButton.
    // One retry: a liveQuery-driven row remount shortly after seeding can
    // reset the reveal state mid-gesture.
    const swipeRow = row.locator("xpath=ancestor::*[@data-testid='swipe-row']").first()
    const target = (await swipeRow.count()) > 0 ? swipeRow : row
    for (let attempt = 0; attempt < 2; attempt++) {
      const box = await target.boundingBox()
      expect(box).not.toBeNull()
      const y = box!.y + box!.height / 2
      await touchDrag(page, { x: box!.x + box!.width * 0.6, y }, { x: box!.x + 10, y })
      if ((await target.getAttribute("data-open").catch(() => null)) === "right") break
      await page.waitForTimeout(1_000)
    }
    // Deterministic intermediate: the row committed to the open state.
    await expect(target).toHaveAttribute("data-open", "right")

    // The revealed action must be interactive, and selecting it must have a
    // real effect: pin → the "pinned" badge renders on the row.
    const pinAction = target.getByTestId("swipe-action-pin")
    await expect(pinAction).toBeVisible()
    await pinAction.click()
    await expect(page.getByTestId(`workflow-pinned-${wfId}`)).toBeVisible({ timeout: 10_000 })
  })
})
