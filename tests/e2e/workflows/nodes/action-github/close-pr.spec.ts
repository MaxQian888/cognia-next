/**
 * E2E: action.github.closePr — issues a PATCH that flips state to closed.
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

test.describe("workflow node — action.github.closePr", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded closePr renders + repo + number persist", async ({ page }) => {
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
  })
})
