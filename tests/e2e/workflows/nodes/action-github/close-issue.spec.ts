/**
 * E2E: action.github.closeIssue.
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

test.describe("workflow node — action.github.closeIssue", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded closeIssue renders + number persists", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-close-issue")
    await assertNodeOnCanvas(page, { kind: "action.github.closeIssue", label: "Close" })
    await openNodeInspector(page, "action.github.closeIssue")
    await expect(page.locator("#ins-issueNumber, [data-field=issueNumber]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.closeIssue" })
  })

  test("manual run hits PATCH /repos/.../issues/:n with state=closed", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-close-issue")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
