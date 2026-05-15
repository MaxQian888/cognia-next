/**
 * E2E: action.github.runIssueLoop — runs the AI loop against a single issue.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../../helpers/db-reset"
import { configureMockBaseUrls, seedAndOpenWorkflow } from "../../../helpers/seed-workflow"
import {
  assertNodeOnCanvas,
  openNodeInspector,
  reopenAndAssertNode,
  saveWorkflow,
} from "../../../helpers/workflow-spec-helpers"

test.describe("workflow node — action.github.runIssueLoop", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, {
      github: process.env.E2E_GITHUB_BASE_URL!,
      anthropic: process.env.E2E_ANTHROPIC_BASE_URL!,
    })
  })

  test("seeded runIssueLoop renders + repo + number + maxIterations persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-run-issue-loop")
    await assertNodeOnCanvas(page, { kind: "action.github.runIssueLoop", label: "Issue Loop" })
    await openNodeInspector(page, "action.github.runIssueLoop")
    await expect(page.locator("#ins-repo, [name=repo]").first()).toBeVisible()
    await expect(page.locator("#ins-number, [name=number]").first()).toBeVisible()
    await expect(page.locator("#ins-maxIterations, [name=maxIterations]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.runIssueLoop" })
  })
})
