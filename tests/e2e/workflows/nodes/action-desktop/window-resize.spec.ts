/**
 * E2E: action.desktop.windowResize — editor + form persistence.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.desktop.windowResize", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded windowResize renders + width + height persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-window-resize")
    await assertNodeOnCanvas(page, { kind: "action.desktop.windowResize", label: "Resize" })
    await openNodeInspector(page, "action.desktop.windowResize")
    await expect(page.locator("#ins-width, [data-field=width]").first()).toBeVisible()
    await expect(page.locator("#ins-height, [data-field=height]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.windowResize" })
  })
})
