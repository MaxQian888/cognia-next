/**
 * E2E: action.github.generateChangelog.
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

test.describe("workflow node — action.github.generateChangelog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded generateChangelog renders + previousTag persists", async ({ page }) => {
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
  })
})
