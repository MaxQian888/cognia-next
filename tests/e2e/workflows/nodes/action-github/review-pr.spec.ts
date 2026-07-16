/**
 * E2E: action.github.reviewPr — POSTs a review (APPROVE / REQUEST_CHANGES / COMMENT).
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { expectGithubCall, registerGithubMockRepo } from "../../../helpers/github-mock"
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
  // 3x budget: each test re-boots the full app AND waits out the
  // github-delivery plugin's dynamic Dexie table registration, which
  // under parallel-worker contention has been measured north of 45s
  // (solo: ~5s). See the e2e-suite-revival plan §7 for the underlying
  // schema-upgrade race.
  test.slow()
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
    // Register the fixtures' repo in the plugin's registry (also waits
    // out github-delivery activation so runs use the real executors).
    await registerGithubMockRepo(page)
  })

  test("seeded reviewPr renders + event + body fields render; node survives reload", async ({
    page,
  }) => {
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
    // Wire truth: the payload the executor actually sent, not just a
    // green run pill.
    await expectGithubCall({
      method: "POST",
      path: "/repos/owner/repo/pulls/1/reviews",
      bodyMatch: { event: "COMMENT", body: "lgtm" },
    })
  })
})
