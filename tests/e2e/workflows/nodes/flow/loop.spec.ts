/**
 * E2E: flow.loop — iterate over an items expression.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — flow.loop", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded flow.loop renders + items / maxIterations are editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-loop")
    await assertNodeOnCanvas(page, { kind: "flow.loop", label: "Loop" })
    await openNodeInspector(page, "flow.loop")
    await expect(page.locator("#ins-items, [name=items]").first()).toBeVisible()
    await expect(page.locator("#ins-maxIterations, [name=maxIterations]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "flow.loop" })
  })

  test("manual run iterates the 3-element items array to completion", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-loop")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
