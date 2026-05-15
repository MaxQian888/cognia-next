/**
 * E2E: action.desktop.findElement — editor + form persistence.
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

test.describe("workflow node — action.desktop.findElement", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded findElement renders + strategy + value persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-find-element")
    await assertNodeOnCanvas(page, { kind: "action.desktop.findElement", label: "Find" })
    await openNodeInspector(page, "action.desktop.findElement")
    await expect(page.locator("#ins-strategy, [name=strategy]").first()).toBeVisible()
    await expect(page.locator("#ins-value, [name=value]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.findElement" })
  })
})
