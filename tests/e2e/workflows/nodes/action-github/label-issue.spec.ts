/**
 * E2E: action.github.labelIssue.
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

test.describe("workflow node — action.github.labelIssue", () => {
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

  test("seeded labelIssue renders + labels array is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-label-issue")
    await assertNodeOnCanvas(page, { kind: "action.github.labelIssue", label: "Label" })
    await openNodeInspector(page, "action.github.labelIssue")
    await expect(page.locator("#ins-add, [data-field=add]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.labelIssue" })
  })

  test("manual run hits POST /repos/.../issues/:n/labels", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-label-issue")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
    // Wire truth: the payload the executor actually sent, not just a
    // green run pill.
    await expectGithubCall({
      method: "POST",
      path: "/repos/owner/repo/issues/1/labels",
      bodyMatch: { labels: ["bug"] },
    })
  })
})
