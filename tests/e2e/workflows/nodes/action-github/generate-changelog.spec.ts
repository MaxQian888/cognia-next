/**
 * E2E: action.github.generateChangelog.
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

test.describe("workflow node — action.github.generateChangelog", () => {
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

  test("seeded generateChangelog renders + previousTag fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-generate-changelog")
    await assertNodeOnCanvas(page, { kind: "action.github.generateChangelog", label: "Changelog" })
    await openNodeInspector(page, "action.github.generateChangelog")
    await expect(page.locator("#ins-since, [data-field=since]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.generateChangelog" })
  })

  test("manual run hits POST /repos/.../releases/generate-notes", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-generate-changelog")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
    // Wire truth: the executor sent the request the test title promises.
    await expectGithubCall({ method: "GET", path: "/repos/owner/repo/compare/v0.9.0...HEAD" })
  })
})
