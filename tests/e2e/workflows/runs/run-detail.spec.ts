/**
 * E2E: opening a run row navigates to the detail page with the Gantt timeline.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow, seedRun } from "../../helpers/seed-workflow"

test.describe("workflow run-detail", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("clicking a run row opens the detail view + timeline", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "multi-step")
    const runId = await seedRun(page, wfId, "succeeded")
    await page.goto(`/workflows/runs?id=${wfId}`)
    const row = page.getByTestId("openRun").first()
    await row.click()
    await page.waitForURL(new RegExp(`/workflows/run\?id=${wfId}&runId=${runId}`))
    await expect(page.locator("[aria-label='Run timeline']")).toBeVisible({ timeout: 15_000 })
  })
})
