/**
 * E2E: ai.classify — editor + runtime through mock Anthropic.
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

test.describe("workflow node — ai.classify", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { anthropic: process.env.E2E_ANTHROPIC_BASE_URL! })
  })

  test("seeded ai.classify node renders + categories field is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "ai-classify")
    await assertNodeOnCanvas(page, { kind: "ai.classify", label: "Classify" })
    await openNodeInspector(page, "ai.classify")
    await expect(page.locator("#ins-categories, [name=categories]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "ai.classify" })
  })

  test("manual run resolves a classification through the mock Anthropic", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "ai-classify")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
