/**
 * E2E: action.github.openPr — issues an Octokit pulls.create through the
 * mock GitHub server.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { expectGithubCall, registerGithubMockRepo } from "../../../helpers/github-mock"
import { configureMockBaseUrls, seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertLatestRunStatus,
  assertNodeOnCanvas,
  expectInspectorFieldValue,
  fillInspectorField,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
  triggerRun,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.github.openPr", () => {
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

  test("seeded openPr renders + title round-trips through save/reload", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-open-pr")
    await assertNodeOnCanvas(page, { kind: "action.github.openPr", label: "Open PR" })
    await openNodeInspector(page, "action.github.openPr")
    await expect(page.locator("#ins-repoFullName, [data-field=repoFullName]").first()).toBeVisible()
    await expect(page.locator("#ins-title, [data-field=title]").first()).toBeVisible()
    await expect(page.locator("#ins-head, [data-field=head]").first()).toBeVisible()
    await expect(page.locator("#ins-base, [data-field=base]").first()).toBeVisible()
    await fillInspectorField(page, "title", "E2E round-trip PR title")
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.openPr" })
    // The reload must bring the edited VALUE back, not just the node
    // shell — this is the half no node spec asserted before.
    await openNodeInspector(page, "action.github.openPr")
    await expectInspectorFieldValue(page, "title", "E2E round-trip PR title")
  })

  test("manual run hits POST /repos/.../pulls on the mock", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-open-pr")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
    // Wire truth: the payload the executor actually sent, not just a
    // green run pill.
    await expectGithubCall({
      method: "POST",
      path: "/repos/owner/repo/pulls",
      bodyMatch: { title: "Fixture PR", head: "feat/fixture", base: "main" },
    })
  })
})
