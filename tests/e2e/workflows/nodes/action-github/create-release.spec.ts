/**
 * E2E: action.github.createRelease.
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

test.describe("workflow node — action.github.createRelease", () => {
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

  test("seeded createRelease renders + tagName + name + body fields render; node survives reload", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-create-release")
    await assertNodeOnCanvas(page, { kind: "action.github.createRelease", label: "Release" })
    await openNodeInspector(page, "action.github.createRelease")
    await expect(page.locator("#ins-tag, [data-field=tag]").first()).toBeVisible()
    await expect(page.locator("#ins-name, [data-field=name]").first()).toBeVisible()
    await expect(page.locator("#ins-body, [data-field=body]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.createRelease" })
  })

  test("manual run hits POST /repos/.../releases", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-create-release")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
    // Wire truth: the payload the executor actually sent, not just a
    // green run pill.
    await expectGithubCall({
      method: "POST",
      path: "/repos/owner/repo/releases",
      bodyMatch: { tag_name: "v1.0.0", name: "v1.0.0", body: "notes" },
    })
  })
})
