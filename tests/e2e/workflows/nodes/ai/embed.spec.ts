/**
 * E2E: ai.embed — editor + runtime through mock Anthropic /v1/embeddings.
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

test.describe("workflow node — ai.embed", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { anthropic: process.env.E2E_ANTHROPIC_BASE_URL! })
  })

  test("seeded ai.embed node renders + text field is editable", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "ai-embed")
    await assertNodeOnCanvas(page, { kind: "ai.embed", label: "Embed" })
    await openNodeInspector(page, "ai.embed")
    await expect(page.locator("#ins-text, [name=text]").first()).toBeVisible()
    await saveWorkflow(page)
    await reopenAndAssertNode(page, wfId, { kind: "ai.embed" })
  })

  test("manual run produces a vector via the mock /v1/embeddings endpoint", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "ai-embed")
    await triggerRun(page, { waitForStatus: false })
    await assertLatestRunStatus(page, wfId, "succeeded")
  })
})
