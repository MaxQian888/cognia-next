/**
 * E2E: status pill colors / labels match the run row's status.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow, seedRun } from "../../helpers/seed-workflow"

test.describe("workflow run — status pill", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("each status renders the corresponding pill testid", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "manual-ai")
    await seedRun(page, wfId, "succeeded")
    await seedRun(page, wfId, "failed")
    await seedRun(page, wfId, "running")
    await page.goto(`/workflows/runs?id=${wfId}`)
    await expect(page.getByTestId("run-status-succeeded")).toHaveCount(1)
    await expect(page.getByTestId("run-status-failed")).toHaveCount(1)
    await expect(page.getByTestId("run-status-running")).toHaveCount(1)
  })
})
