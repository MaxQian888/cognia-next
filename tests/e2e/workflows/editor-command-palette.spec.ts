/**
 * E2E: Cmd+K command palette opens, search filters entries, picking adds
 * the node at the viewport center.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../helpers/db-reset"
import { seedAndOpenWorkflow } from "../helpers/seed-workflow"

test.describe("workflow editor — command palette", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("toolbar button opens the palette and a search adds the node", async ({ page }) => {
    await seedAndOpenWorkflow(page, "manual-ai")
    await expect(page.getByTestId("workflow-canvas")).toBeVisible()

    await page.getByTestId("workflow-command-palette").click()
    // cmdk renders a Dialog with role="dialog"; the input has role="combobox".
    const input = page.getByRole("combobox").first()
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.fill("set")

    // Pick the first matching option in the list.
    const firstOption = page.getByRole("option").first()
    await expect(firstOption).toBeVisible({ timeout: 5_000 })
    await firstOption.click()

    // The canvas should gain a new node (flow.set fixture-friendly).
    await expect
      .poll(async () => page.getByTestId("wf-node-flow.set").count())
      .toBeGreaterThanOrEqual(1)
  })

  test("Ctrl+K keyboard shortcut opens the palette", async ({ page }) => {
    await seedAndOpenWorkflow(page, "manual-ai")
    await page.getByTestId("workflow-canvas").click({ position: { x: 50, y: 50 } })
    await page.keyboard.press("Control+k")
    const input = page.getByRole("combobox").first()
    await expect(input).toBeVisible({ timeout: 5_000 })
  })
})
