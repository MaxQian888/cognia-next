/**
 * E2E: zundo-backed undo / redo via toolbar buttons + keyboard shortcut.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — undo / redo", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("toolbar undo restores a deleted node; redo deletes it again", async ({ page }) => {
    await seedAndOpenWorkflow(page, "manual-ai")
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()

    // Initial state: both nodes present.
    await expect(page.getByTestId("wf-node-trigger.manual").first()).toBeVisible()
    await expect(page.getByTestId("wf-node-ai.prompt").first()).toBeVisible()

    // Select the ai.prompt node + delete via inspector.
    await page.getByTestId("wf-node-ai.prompt").first().click()
    await page.getByRole("button", { name: /delete node/i }).click()
    await expect(page.getByTestId("wf-node-ai.prompt")).toHaveCount(0)

    // Undo → node returns.
    await expect(page.getByTestId("workflow-undo")).toBeEnabled()
    await page.getByTestId("workflow-undo").click()
    await expect(page.getByTestId("wf-node-ai.prompt").first()).toBeVisible()

    // Redo → node disappears again.
    await expect(page.getByTestId("workflow-redo")).toBeEnabled()
    await page.getByTestId("workflow-redo").click()
    await expect(page.getByTestId("wf-node-ai.prompt")).toHaveCount(0)
  })

  test("Ctrl+Z keyboard shortcut undoes the last change", async ({ page }) => {
    await seedAndOpenWorkflow(page, "manual-ai")
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()

    // Click on the canvas first so the keyboard handler is in scope.
    await page.getByTestId("workflow-canvas").click({ position: { x: 50, y: 50 } })

    // Add another node, then Ctrl+Z.
    await page.getByTestId("wf-sidebar-flow.set").first().click()
    await expect(page.getByTestId("wf-node-flow.set").first()).toBeVisible()

    // Cmd on macOS handled via the same key code; Playwright accepts
    // Control+Z and the editor uses ctrlKey || metaKey.
    await page.keyboard.press("Control+z")
    await expect(page.getByTestId("wf-node-flow.set")).toHaveCount(0)
  })
})
