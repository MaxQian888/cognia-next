/**
 * E2E: action.github.closePr — issues a PATCH that flips state to closed.
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

test.describe("workflow node — action.github.closePr", () => {
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

  test("seeded closePr renders + repo + number fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-close-pr")
    await assertNodeOnCanvas(page, { kind: "action.github.closePr", label: "Close PR" })
    await openNodeInspector(page, "action.github.closePr")
    await expect(page.locator("#ins-repoFullName, [data-field=repoFullName]").first()).toBeVisible()
    await expect(page.locator("#ins-prNumber, [data-field=prNumber]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.closePr" })
  })

  test("manual run hits PATCH /repos/.../pulls/:n with state=closed", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-close-pr")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
    // Wire truth: the payload the executor actually sent, not just a
    // green run pill.
    await expectGithubCall({
      method: "PATCH",
      path: "/repos/owner/repo/pulls/1",
      bodyMatch: { state: "closed" },
    })
  })
})
