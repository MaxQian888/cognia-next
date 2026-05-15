/**
 * E2E: action.github.mergePr — PUT /pulls/:n/merge with method selection.
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

test.describe("workflow node — action.github.mergePr", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded mergePr renders + mergeMethod is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-merge-pr")
    await assertNodeOnCanvas(page, { kind: "action.github.mergePr", label: "Merge PR" })
    await openNodeInspector(page, "action.github.mergePr")
    await expect(page.locator("#ins-mergeMethod, [name=mergeMethod]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.mergePr" })
  })

  test("manual run hits PUT /repos/.../pulls/:n/merge", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-merge-pr")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
