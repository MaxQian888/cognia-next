/**
 * E2E: shortcuts cheatsheet modal renders the help keymap.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../helpers/seed-workflow"

test.describe("workflow editor — shortcuts cheatsheet", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("pressing ? opens the shortcuts dialog with keymap rows", async ({ page }) => {
    await seedAndOpenWorkflow(page, "manual-ai")
    await page.keyboard.press("Shift+/") // ? on most keyboard layouts
    const dialog = page.getByRole("dialog", { name: /shortcuts/i }).first()
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog.getByText(/save/i)).toBeVisible()
    await expect(dialog.getByText(/undo/i)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  })
})
