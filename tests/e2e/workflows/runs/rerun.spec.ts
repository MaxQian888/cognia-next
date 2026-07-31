/**
 * E2E: the rerun button on a run-detail page creates a fresh run.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { configureMockBaseUrls, seedAndOpenWorkflow, seedRun } from "../../helpers/seed-workflow"

test.describe("workflow run-detail — rerun", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
    await configureMockBaseUrls(page, { anthropic: process.env.E2E_ANTHROPIC_BASE_URL! })
  })

  test("rerun button enqueues a new run that shows up in the list", async ({ page }) => {
    const wfId = await seedAndOpenWorkflow(page, "manual-ai")
    const runId = await seedRun(page, wfId, "succeeded")
    await page.goto(`/workflows/run?id=${wfId}&runId=${runId}`)
    await expect(page.getByTestId("run-detail-rerun")).toBeVisible()
    await page.getByTestId("run-detail-rerun").click()
    await page.goto(`/workflows/runs?id=${wfId}`)
    await expect(page.getByTestId("openRun")).toHaveCount(2, { timeout: 30_000 })
  })
})
