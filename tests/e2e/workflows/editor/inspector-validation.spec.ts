/**
 * E2E: inspector form validation surfaces field-level errors and a node
 * error badge when required params are missing.
 */

import { expect, test } from "@/tests/e2e/fixtures/test"
import { resetCogniaDb } from "../../helpers/db-reset"
import { seedAndOpenWorkflow } from "../../helpers/seed-workflow"
import { openNodeInspector, saveWorkflow } from "../../helpers/workflow-spec-helpers"

test.describe("workflow editor — inspector validation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await resetCogniaDb(page)
  })

  test("clearing a required field surfaces a field error + node error badge", async ({ page }) => {
    await seedAndOpenWorkflow(page, "ai-prompt")
    await openNodeInspector(page, "ai.prompt")

    const userPrompt = page.locator("#ins-userPrompt, [data-field=userPrompt]").first()
    await userPrompt.fill("")
    await saveWorkflow(page)

    await expect(page.locator("[data-testid^=field-error-]").first()).toBeVisible({
      timeout: 5_000,
    })
    await expect(page.getByTestId("wf-node-error-badge").first()).toBeVisible({ timeout: 5_000 })
  })
})
