/**
 * E2E: save → reopen lifecycle.
 *
 * Add a node, click Save (which persists via replaceWorkflow), navigate
 * away, navigate back, assert the node count + label match.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — save and reopen", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("renaming + adding a node survives a route round-trip", async ({ page }) => {
    const id = await seedAndOpenWorkflow(page, "manual-ai")
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()

    // Rename the workflow via the name input in the toolbar.
    const nameInput = page.locator('[data-testid="workflow-toolbar"] input[type="text"]').first()
    await nameInput.fill("Renamed by E2E")

    // Add a flow.set node by clicking the sidebar entry.
    await page.getByTestId("wf-sidebar-flow.set").first().click()
    await expect(page.getByTestId("wf-node-flow.set").first()).toBeVisible()

    // Save — button only enabled when dirty; should become disabled after.
    const saveBtn = page.getByTestId("workflow-save")
    await expect(saveBtn).toBeEnabled()
    await saveBtn.click()
    await expect(saveBtn).toBeDisabled({ timeout: 10_000 })

    // Round-trip: navigate to the library, then back to the editor.
    await page.goto("/workflows", { waitUntil: "domcontentloaded" })
    await page.goto(`/workflows/${id}`)
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()

    // Name persisted + extra node persisted.
    await expect(
      page.locator('[data-testid="workflow-toolbar"] input[type="text"]').first()
    ).toHaveValue("Renamed by E2E")
    await expect(page.getByTestId("wf-node-trigger.manual").first()).toBeVisible()
    await expect(page.getByTestId("wf-node-ai.prompt").first()).toBeVisible()
    await expect(page.getByTestId("wf-node-flow.set").first()).toBeVisible()

    // Verify the Dexie row's nodes count matches.
    const stored = await page.evaluate(async (wfId: string) => {
      const { getWorkflow } = await import("@/lib/db/workflows")
      return (await getWorkflow(wfId))?.nodes.length ?? 0
    }, id)
    expect(stored).toBe(3)
  })
})
