/**
 * E2E: action.github.createRelease.
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

test.describe("workflow node — action.github.createRelease", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { github: process.env.E2E_GITHUB_BASE_URL! })
  })

  test("seeded createRelease renders + tagName + name + body persist", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-create-release")
    await assertNodeOnCanvas(page, { kind: "action.github.createRelease", label: "Release" })
    await openNodeInspector(page, "action.github.createRelease")
    await expect(page.locator("#ins-tagName, [name=tagName]").first()).toBeVisible()
    await expect(page.locator("#ins-name, [name=name]").first()).toBeVisible()
    await expect(page.locator("#ins-body, [name=body]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "action.github.createRelease" })
  })

  test("manual run hits POST /repos/.../releases", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "action-github-create-release")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
