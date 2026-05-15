/**
 * E2E: action.github.pushTag.
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

test.describe("workflow node — action.github.pushTag", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded pushTag renders + tag + sha persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-push-tag")
    await assertNodeOnCanvas(page, { kind: "action.github.pushTag", label: "Push Tag" })
    await openNodeInspector(page, "action.github.pushTag")
    await expect(page.locator("#ins-tag, [name=tag]").first()).toBeVisible()
    await expect(page.locator("#ins-sha, [name=sha]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.pushTag" })
  })

  test("manual run hits POST /repos/.../git/refs with refs/tags/<tag>", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-push-tag")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
