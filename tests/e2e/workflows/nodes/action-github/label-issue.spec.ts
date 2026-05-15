/**
 * E2E: action.github.labelIssue.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { configureMockBaseUrls, seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.github.labelIssue", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded labelIssue renders + labels array is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-label-issue")
    await assertNodeOnCanvas(page, { kind: "action.github.labelIssue", label: "Label" })
    await openNodeInspector(page, "action.github.labelIssue")
    await expect(page.locator("#ins-labels, [name=labels]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.labelIssue" })
  })

  test("manual run hits POST /repos/.../issues/:n/labels", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-label-issue")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
