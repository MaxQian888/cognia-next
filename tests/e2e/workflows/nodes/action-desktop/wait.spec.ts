/**
 * E2E: action.desktop.wait — editor + form persistence.
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

test.describe("workflow node — action.desktop.wait", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded wait renders + conditionExpr + timeoutMs persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-wait")
    await assertNodeOnCanvas(page, { kind: "action.desktop.wait", label: "Wait" })
    await openNodeInspector(page, "action.desktop.wait")
    await expect(page.locator("#ins-conditionExpr, [name=conditionExpr]").first()).toBeVisible()
    await expect(page.locator("#ins-timeoutMs, [name=timeoutMs]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.wait" })
  })
})
