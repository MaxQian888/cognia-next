/**
 * E2E: durable workflowRunEvents log replays correctly across page reload.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow, seedRun } from "../../helpers/seed-workflow"

test.describe("workflow run-detail — event log replay", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("timeline rows survive a hard reload", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "multi-step")
    const runId = await seedRun(page, wfId, "succeeded")
    await page.goto(`/workflows/${wfId}/runs/${runId}`)
    const timeline = page.locator("[aria-label='Run timeline']")
    await expect(timeline).toBeVisible({ timeout: 15_000 })
    const beforeCount = await timeline.locator("[data-testid^=timeline-row-]").count()

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(timeline).toBeVisible({ timeout: 15_000 })
    const afterCount = await timeline.locator("[data-testid^=timeline-row-]").count()
    expect(afterCount).toBe(beforeCount)
  })
})
