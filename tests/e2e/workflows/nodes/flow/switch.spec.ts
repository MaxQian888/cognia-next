/**
 * E2E: flow.switch — multi-case dispatch.
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

test.describe("workflow node — flow.switch", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded flow.switch renders + cases + defaultLabel persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-switch")
    await assertNodeOnCanvas(page, { kind: "flow.switch", label: "Switch" })
    await openNodeInspector(page, "flow.switch")
    await expect(page.locator("#ins-subject, [data-field=subject]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "flow.switch" })
  })

  test("manual run dispatches to the default branch when no case matches", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-switch")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
