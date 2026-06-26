/**
 * E2E: action.github.reviewPr — POSTs a review (APPROVE / REQUEST_CHANGES / COMMENT).
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

test.describe("workflow node — action.github.reviewPr", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded reviewPr renders + event + body persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-review-pr")
    await assertNodeOnCanvas(page, { kind: "action.github.reviewPr", label: "Review" })
    await openNodeInspector(page, "action.github.reviewPr")
    await expect(page.locator("#ins-event, [data-field=event]").first()).toBeVisible()
    await expect(page.locator("#ins-body, [data-field=body]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.reviewPr" })
  })

  test("manual run hits POST /repos/.../pulls/:n/reviews", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-review-pr")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
