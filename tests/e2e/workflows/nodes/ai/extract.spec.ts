/**
 * E2E: ai.extract — editor + runtime through mock Anthropic.
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

test.describe("workflow node — ai.extract", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { anthropic: process.env.E2E_ANTHROPIC_BASE_URL! })
    // ai.extract expects a JSON-mode response. Configure the mock to return
    // a JSON payload matching the seeded schema.
  })

  test("seeded ai.extract node renders + schema field is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "ai-extract")
    await assertNodeOnCanvas(page, { kind: "ai.extract", label: "Extract" })
    await openNodeInspector(page, "ai.extract")
    await expect(page.locator("#ins-schemaJson, [name=schemaJson]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "ai.extract" })
  })

  test("manual run yields a succeeded row when the mock returns JSON", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "ai-extract")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
