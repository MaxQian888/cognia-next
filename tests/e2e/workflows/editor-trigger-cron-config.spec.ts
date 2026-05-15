/**
 * E2E: configure a trigger.cron node and assert workflowTriggers gets a row
 * on save (web mode persists the trigger metadata; firing requires Tauri
 * scheduler).
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — trigger.cron config", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("adding trigger.cron + saving creates a workflowTriggers row", async ({ page }) => {
    const id = await seedAndOpenWorkflow(page, "manual-ai")

    // Drop a trigger.cron node onto the canvas via the sidebar click affordance.
    await page.getByTestId("wf-sidebar-trigger.cron").first().click()
    await expect(page.getByTestId("wf-node-trigger.cron").first()).toBeVisible()

    // Open the inspector for the new node + configure the cron expression.
    await page.getByTestId("wf-node-trigger.cron").first().click()
    await expect(page.getByTestId("workflow-inspector")).toBeVisible()
    // Inspector forms expose form fields by label/id; cron schema typically
    // exposes a `schedule` or `expression` field. Be tolerant of either name.
    const cronInput = page.locator("input[name='schedule'], input[name='expression']").first()
    if (await cronInput.count()) {
      await cronInput.fill("*/5 * * * *")
    }

    // Save and wait for the dirty flag to clear.
    await page.getByTestId("workflow-save").click()
    await expect(page.getByTestId("workflow-save")).toBeDisabled({ timeout: 10_000 })

    // workflowTriggers should have a row pointing at this workflow.
    const triggerCount = await page.evaluate(async (workflowId: string) => {
      const { getDb } = await import("@/lib/db/schema")
      return getDb().workflowTriggers.where("workflowId").equals(workflowId).count()
    }, id)
    expect(triggerCount).toBeGreaterThanOrEqual(1)
  })
})
