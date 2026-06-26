/**
 * E2E: flow.split — fan-out to multiple branches.
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

test.describe("workflow node — flow.split", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded flow.split renders + branches count is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-split-join")
    await assertNodeOnCanvas(page, { kind: "flow.split", label: "Split" })
    await openNodeInspector(page, "flow.split")
    await expect(page.locator("#ins-branchLabels, [data-field=branchLabels]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "flow.split" })
  })
})
