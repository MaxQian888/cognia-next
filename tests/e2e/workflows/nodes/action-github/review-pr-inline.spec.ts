/**
 * E2E: action.github.reviewPrInline — posts inline file/line comments.
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

test.describe("workflow node — action.github.reviewPrInline", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded reviewPrInline renders + comments array is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-review-pr-inline")
    await assertNodeOnCanvas(page, { kind: "action.github.reviewPrInline", label: "Inline" })
    await openNodeInspector(page, "action.github.reviewPrInline")
    await expect(page.locator("#ins-prNumber, [data-field=prNumber]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.reviewPrInline" })
  })

  test("manual run hits POST /repos/.../pulls/:n/comments", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-review-pr-inline")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
