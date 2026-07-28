/**
 * E2E: flow.join — converging branch wait-for-all / wait-for-any.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
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

test.describe("workflow node — flow.join", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded flow.join renders + strategy field is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-split-join")
    await assertNodeOnCanvas(page, { kind: "flow.join", label: "Join" })
    await openNodeInspector(page, "flow.join")
    await expect(page.locator("#ins-joinPolicy, [data-field=joinPolicy]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "flow.join" })
  })

  test("the split-join fixture completes with both incoming branches gathered", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "flow-split-join")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
