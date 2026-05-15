/**
 * E2E: action.desktop.type — editor + form persistence.
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

test.describe("workflow node — action.desktop.type", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded type renders + text persists", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-desktop-type")
    await assertNodeOnCanvas(page, { kind: "action.desktop.type", label: "Type" })
    await openNodeInspector(page, "action.desktop.type")
    await expect(page.locator("#ins-text, [name=text]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.desktop.type" })
  })
})
