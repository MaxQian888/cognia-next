/**
 * E2E: data.transform — editor + runtime (in-memory expression eval).
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

test.describe("workflow node — data.transform", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("seeded data.transform node renders + expression field is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "data-transform")
    await assertNodeOnCanvas(page, { kind: "data.transform", label: "Transform" })
    await openNodeInspector(page, "data.transform")
    await expect(page.locator("#ins-expression, [data-field=expression]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "data.transform" })
  })

  test("manual run produces a succeeded row from the eval'd expression", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "data-transform")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
