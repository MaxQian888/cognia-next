/**
 * E2E: step inspector search + filter narrows the timeline.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow, seedRun } from "../../helpers/seed-workflow"

test.describe("workflow run-detail — step search/filter", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("step search input is visible + accepts text", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "multi-step")
    const runId = await seedRun(page, wfId, "succeeded")
    await page.goto(`/workflows/${wfId}/runs/${runId}`)
    const search = page
      .getByPlaceholder(/search step/i)
      .or(page.getByRole("textbox", { name: /search/i }))
    await expect(search.first()).toBeVisible({ timeout: 15_000 })
    await search.first().fill("prompt")
  })
})
