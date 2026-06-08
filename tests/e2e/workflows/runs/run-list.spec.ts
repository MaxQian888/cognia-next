/**
 * E2E: run-list pagination + filtering at /workflows/<id>/runs.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow, seedRun } from "../../helpers/seed-workflow"

test.describe("workflow run-list", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("renders one row per seeded run + status pills appear", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "manual-ai")
    await seedRun(page, wfId, "succeeded")
    await seedRun(page, wfId, "failed")
    await seedRun(page, wfId, "running")
    await page.goto(`/workflows/runs?id=${wfId}`)
    await expect(page.getByTestId("run-list")).toBeVisible()
    await expect(page.getByTestId("openRun")).toHaveCount(3)
    await expect(page.getByTestId("run-status-succeeded").first()).toBeVisible()
    await expect(page.getByTestId("run-status-failed").first()).toBeVisible()
    await expect(page.getByTestId("run-status-running").first()).toBeVisible()
  })
})
