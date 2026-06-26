/**
 * E2E: flow.wait — duration-based pause.
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

test.describe("workflow node — flow.wait", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded flow.wait renders + durationMs is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-wait")
    await assertNodeOnCanvas(page, { kind: "flow.wait", label: "Wait" })
    await openNodeInspector(page, "flow.wait")
    await expect(page.locator("#ins-durationMs, [data-field=durationMs]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "flow.wait" })
  })

  test("manual run completes once the wait elapses", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-wait")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
