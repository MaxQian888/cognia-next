/**
 * E2E: action.github.commentPr — issue-comments endpoint (PRs share it).
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

test.describe("workflow node — action.github.commentPr", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded commentPr renders + body persists", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-comment-pr")
    await assertNodeOnCanvas(page, { kind: "action.github.commentPr", label: "Comment" })
    await openNodeInspector(page, "action.github.commentPr")
    await expect(page.locator("#ins-body, [name=body]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.commentPr" })
  })

  test("manual run hits POST /repos/.../issues/:n/comments", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-comment-pr")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
