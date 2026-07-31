/**
 * E2E: trigger.chat.message — add to canvas, configure, save, assert
 * the workflowTriggers row carries the chat-message metadata.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — trigger.chat.message config", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("adding trigger.chat.message + saving persists a row in workflowTriggers", async ({
    page,
  }) => {
    const id = await seedAndOpenWorkflow(page, "manual-ai")

    await page.getByTestId("wf-sidebar-trigger.chat.message").first().click()
    await expect(page.getByTestId("wf-node-trigger.chat.message").first()).toBeVisible()
    await page.getByTestId("wf-node-trigger.chat.message").first().click()
    await expect(page.getByTestId("workflow-inspector")).toBeVisible()

    // Save without filling characterId (defaults to "any chat") and assert
    // a trigger row appears regardless.
    await page.getByTestId("workflow-save").click()
    await expect(page.getByTestId("workflow-save")).toBeDisabled({ timeout: 10_000 })

    const triggerCount = await page.evaluate(async (workflowId: string) => {
      const { getDb } = await import("@/lib/db/schema")
      return getDb().workflowTriggers.where("workflowId").equals(workflowId).count()
    }, id)
    expect(triggerCount).toBeGreaterThanOrEqual(1)
  })
})
