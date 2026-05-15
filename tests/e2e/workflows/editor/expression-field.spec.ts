/**
 * E2E: expression field shows {{ }} autosuggestion popups when typing.
 */

import { expect, test } from "@playwright/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../helpers/seed-workflow"
import { openNodeInspector } from "../../helpers/workflow-spec-helpers"

test.describe("workflow editor — expression field", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("typing {{ in an expression field opens the suggestion popover", async ({ page }) => {
    await seedAndOpenWorkflow(page, "data-transform")
    await openNodeInspector(page, "data.transform")

    const expr = page.locator("#ins-expression, [name=expression]").first()
    await expr.click()
    await expr.fill("{{ ")
    // The popover surfaces nearby variables (trigger.firedAt etc.).
    await expect(
      page.getByRole("listbox").or(page.locator("[data-testid=expression-suggestions]")).first()
    ).toBeVisible({ timeout: 5_000 })
  })
})
