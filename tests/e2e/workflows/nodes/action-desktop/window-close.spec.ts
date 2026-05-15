/**
 * E2E: action.desktop.windowClose — editor + form persistence.
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

test.describe("workflow node — action.desktop.windowClose", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded windowClose renders + windowTitle persists", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-window-close")
    await assertNodeOnCanvas(page, { kind: "action.desktop.windowClose", label: "Close" })
    await openNodeInspector(page, "action.desktop.windowClose")
    await expect(page.locator("#ins-windowTitle, [name=windowTitle]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.windowClose" })
  })
})
