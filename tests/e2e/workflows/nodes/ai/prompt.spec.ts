/**
 * E2E: ai.prompt — editor + runtime through mock Anthropic.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
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

test.describe("workflow node — ai.prompt", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { anthropic: process.env.E2E_ANTHROPIC_BASE_URL! })
  })

  test("seeded ai.prompt node renders on canvas + inspector exposes required fields", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "ai-prompt")
    await assertNodeOnCanvas(page, { kind: "ai.prompt", label: "Prompt" })
    await openNodeInspector(page, "ai.prompt")
    await expect(page.locator("#ins-userPrompt, [data-field=userPrompt]").first()).toBeVisible()
    await expect(page.locator("#ins-model, [data-field=model]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "ai.prompt" })
  })

  test("manual run lands a succeeded run row when the mock Anthropic responds", async ({
    page,
  }) => {
    const wfId = await seedAndOpenWorkflow(page, "ai-prompt")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
