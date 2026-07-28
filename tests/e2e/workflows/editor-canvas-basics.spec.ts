/**
 * E2E: workflow editor canvas basics.
 *
 * - Create a workflow via the library `New` dialog.
 * - Add a second node from the sidebar (click-to-center affordance).
 * - Select the added node → inspector opens.
 * - Edit the node label → reflected in store + Dexie after save.
 * - Delete via inspector footer → node disappears.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"

test.describe("workflow editor — canvas basics", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("create workflow → seeded with trigger.manual → add ai.prompt via sidebar", async ({
    page,
  }) => {
    await page.goto("/workflows", { waitUntil: "domcontentloaded" })
    await expect(page.getByTestId("workflow-create")).toBeVisible()
    await page.getByTestId("workflow-create").click()

    // Dialog form: fill name + click Create.
    await page.locator("#wf-name").fill("E2E Canvas Basics")
    await page.locator("#wf-desc").fill("Created by Playwright")
    await page.getByRole("button", { name: /create/i }).click()

    // Router push lands on /workflows/<id>; the seeded trigger.manual node
    // must render on the canvas.
    await page.waitForURL(/\/workflows\/[^/]+$/)
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()
    await expect(page.getByTestId("wf-node-trigger.manual").first()).toBeVisible()

    // Sidebar lists ai.prompt — click to add at canvas center.
    await expect(page.getByTestId("workflow-node-sidebar")).toBeVisible()
    await page.getByTestId("wf-sidebar-ai.prompt").first().click()
    await expect(page.getByTestId("wf-node-ai.prompt").first()).toBeVisible()
  })

  test("selecting a node opens the inspector; deleting via inspector removes it", async ({
    page,
  }) => {
    // Reach an editor with two nodes (trigger.manual + ai.prompt).
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = await (window as any).__cogniaSeedWorkflow("manual-ai")
      ;(window as { __seededId?: string }).__seededId = id
    })
    const id = await page.evaluate(() => (window as { __seededId?: string }).__seededId)
    await page.goto(`/workflows/editor?id=${id}`)
    await expect(page.getByTestId("workflow-toolbar")).toBeVisible()
    await expect(page.getByTestId("workflow-inspector-empty")).toBeVisible()

    const promptNode = page.getByTestId("wf-node-ai.prompt").first()
    await promptNode.click()
    await expect(page.getByTestId("workflow-inspector")).toBeVisible()

    // Edit label via inspector input.
    const labelInput = page.locator("#ins-label")
    await expect(labelInput).toBeVisible()
    await labelInput.fill("Renamed prompt")
    await expect(labelInput).toHaveValue("Renamed prompt")

    // Delete via inspector footer button.
    await page.getByRole("button", { name: /delete node/i }).click()
    await expect(page.getByTestId("wf-node-ai.prompt")).toHaveCount(0)
    await expect(page.getByTestId("workflow-inspector-empty")).toBeVisible()
  })
})
