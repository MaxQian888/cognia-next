/**
 * E2E: action.github.openPr — issues an Octokit pulls.create through the
 * mock GitHub server.
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

test.describe("workflow node — action.github.openPr", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded openPr renders + repo + title + head + base persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-open-pr")
    await assertNodeOnCanvas(page, { kind: "action.github.openPr", label: "Open PR" })
    await openNodeInspector(page, "action.github.openPr")
    await expect(page.locator("#ins-repo, [name=repo]").first()).toBeVisible()
    await expect(page.locator("#ins-title, [name=title]").first()).toBeVisible()
    await expect(page.locator("#ins-head, [name=head]").first()).toBeVisible()
    await expect(page.locator("#ins-base, [name=base]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.openPr" })
  })

  test("manual run hits POST /repos/.../pulls on the mock", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-open-pr")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
