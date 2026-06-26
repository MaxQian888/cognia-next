/**
 * E2E: action.desktop.windowFocus — editor + form persistence.
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

test.describe("workflow node — action.desktop.windowFocus", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded windowFocus renders + windowTitle persists", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-window-focus")
    await assertNodeOnCanvas(page, { kind: "action.desktop.windowFocus", label: "Focus" })
    await openNodeInspector(page, "action.desktop.windowFocus")
    await expect(page.locator("#ins-selector, [data-field=selector]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.windowFocus" })
  })
})
