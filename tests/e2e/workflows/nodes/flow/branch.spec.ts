/**
 * E2E: flow.branch — condition evaluation + downstream propagation.
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

test.describe("workflow node — flow.branch", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded flow.branch renders + condition is editable + persists", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "branch")
    await assertNodeOnCanvas(page, { kind: "flow.branch", label: "Branch" })
    await openNodeInspector(page, "flow.branch")
    await expect(page.locator("#ins-condition, [data-field=condition]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "flow.branch" })
  })

  test("running the seeded branch fixture lands a succeeded run", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "branch")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
