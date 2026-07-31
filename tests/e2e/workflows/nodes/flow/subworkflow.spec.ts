/**
 * E2E: flow.subworkflow — editor side only (running a real sub-workflow
 * requires a child id which we seed separately in unit tests).
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — flow.subworkflow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded flow.subworkflow renders + workflowId is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-subworkflow")
    await assertNodeOnCanvas(page, { kind: "flow.subworkflow", label: "Sub" })
    await openNodeInspector(page, "flow.subworkflow")
    await expect(page.locator("#ins-workflowId, [data-field=workflowId]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "flow.subworkflow" })
  })
})
